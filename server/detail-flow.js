import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  MAX_DETAIL_IMAGES,
  MAX_REF_IMAGE_BYTES,
  createOpenAIResponse,
  editImageWithReferences,
  fileToDataUri,
  marketLanguage,
  openaiConfig,
  parseJsonFromModel,
  saveGeneratedImage,
} from "./openai-api.js";
import { imageId } from "./product-profile.js";
import {
  DETAIL_IMAGE_ANALYSIS_SYSTEM_PROMPT,
  DETAIL_IMAGE_ANALYSIS_USER_PROMPT,
  EXTRACTION_PLAN_SYSTEM_PROMPT,
  EXTRACTION_PLAN_USER_PROMPT,
} from "./tkshop-prompts.js";

const MIN_PAGES = 3;
const MAX_PAGES = 10;
const MAX_COMPOSE_SIDE = 1536;
const MAX_COMPOSE_WIDTH = 1536;

function log(onLog, message, extra) {
  onLog?.(message, extra);
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function parseImageSize(buf) {
  if (!buf || buf.length < 10) return { width: 0, height: 0 };
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  const gif = buf.toString("ascii", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return { width: 0, height: 0 };
}

function readImageSize(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = Math.min(fs.fstatSync(fd).size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    return parseImageSize(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

export function mapSourceFiles(files = [], urls = []) {
  return (files || []).filter((file) => file && fs.existsSync(file)).map((file, index) => {
    const size = readImageSize(file);
    return {
      id: imageId(index),
      source_id: `S${String(index + 1).padStart(3, "0")}`,
      filename: path.basename(file),
      width: size.width,
      height: size.height,
      file,
      url: urls[index] || "",
    };
  });
}

export function convertSpecItems(specItems = []) {
  const grouped = {};
  const mapped = {};
  for (const entry of specItems || []) {
    const baseName = String(entry?.name || "").trim().replace(/组$/, "");
    if (!baseName) continue;
    const groupedValues = Array.isArray(entry.grouped_values) ? entry.grouped_values : [];
    const mappedValues = Array.isArray(entry.mapped_values) ? entry.mapped_values : [];
    if (groupedValues.length && mappedValues.length) continue;
    if (groupedValues.length) {
      const bucket = grouped[baseName] || [];
      for (const value of groupedValues) {
        const clean = String(value || "").trim();
        if (clean && !bucket.includes(clean)) bucket.push(clean);
      }
      if (bucket.length) grouped[baseName] = bucket;
    }
    if (mappedValues.length) {
      const target = mapped[baseName] || {};
      for (const pair of mappedValues) {
        const key = String(pair?.key || "").trim();
        if (!key) continue;
        const bucket = Array.isArray(target[key]) ? [...target[key]] : [];
        const values = Array.isArray(pair.values) ? pair.values : pair.values != null ? [pair.values] : [];
        for (const value of values) {
          const clean = String(value || "").trim();
          if (clean && !bucket.includes(clean)) bucket.push(clean);
        }
        if (bucket.length) target[key] = bucket;
      }
      if (Object.keys(target).length) mapped[baseName] = target;
    }
  }
  const specs = {};
  const specEntries = {};
  for (const [name, values] of Object.entries(grouped)) {
    if (values.length) specs[`${name}组`] = values;
  }
  for (const [name, relationships] of Object.entries(mapped)) {
    const compact = {};
    for (const [key, values] of Object.entries(relationships)) {
      if (!values?.length) continue;
      compact[key] = values.length === 1 ? values[0] : values;
    }
    if (Object.keys(compact).length) specEntries[name] = compact;
  }
  return { specs, spec_entries: specEntries };
}

function compactImage(image) {
  const text = Array.isArray(image.text) ? image.text.filter((item) => String(item || "").trim()) : [];
  const next = {
    id: image.id,
    source_id: image.source_id || "",
    filename: image.filename || "",
    text,
    visual: image.visual || "",
    unclear: Array.isArray(image.unclear) ? image.unclear : [],
  };
  if (image.specs && Object.keys(image.specs).length) next.specs = image.specs;
  if (image.spec_entries && Object.keys(image.spec_entries).length) next.spec_entries = image.spec_entries;
  return next;
}

function marketName(site) {
  const code = String(site || "TH").toUpperCase();
  if (code === "MY") return "马来西亚";
  if (code === "PH") return "菲律宾";
  return "泰国";
}

function lookupKey(value) {
  return String(value || "").trim().toLowerCase();
}

function sourceIndex(list) {
  const map = new Map();
  for (const source of list || []) {
    for (const key of [source.filename, source.id, source.source_id]) {
      if (key) map.set(lookupKey(key), source);
    }
  }
  return map;
}

function filenamesFromTask(task) {
  const regions = Array.isArray(task?.source_regions) ? task.source_regions : [];
  const names = regions.map((region) => String(region?.filename || "").trim()).filter(Boolean);
  if (names.length) return names;
  const fallback = String(task?.filename || "").trim();
  return fallback ? [fallback] : [];
}

function imagesFromExtraction(list, parsed) {
  const byFile = new Map();
  for (const source of list) {
    byFile.set(lookupKey(source.filename), {
      id: source.id,
      source_id: source.source_id,
      filename: source.filename,
      text: [],
      visual: [],
      unclear: [],
    });
  }
  const tasks = Array.isArray(parsed.image_tasks) ? parsed.image_tasks : [];
  if (tasks.length) {
    for (const task of tasks) {
      const text = Array.isArray(task.source_text) ? task.source_text : [];
      const visual = String(task.visual_content || task.theme || "").trim();
      for (const name of filenamesFromTask(task)) {
        const rec = byFile.get(lookupKey(name));
        if (!rec) continue;
        rec.text.push(...text);
        if (visual) rec.visual.push(visual);
      }
    }
  } else {
    for (const image of parsed.images || []) {
      const rec = byFile.get(lookupKey(image.filename))
        || byFile.get(lookupKey(image.id))
        || byFile.get(lookupKey(image.image_id));
      if (!rec) continue;
      if (Array.isArray(image.text)) rec.text.push(...image.text);
      if (image.visual) rec.visual.push(image.visual);
      if (Array.isArray(image.unclear)) rec.unclear.push(...image.unclear);
      rec.specs = image.specs;
      rec.spec_entries = image.spec_entries;
    }
  }
  return list.map((source) => {
    const rec = byFile.get(lookupKey(source.filename)) || {};
    return compactImage({
      ...rec,
      id: source.id,
      source_id: source.source_id,
      filename: source.filename,
      text: unique(rec.text),
      visual: unique(rec.visual).join("；"),
      unclear: unique(rec.unclear),
    });
  });
}

function taskTexts(task) {
  return Array.isArray(task?.source_text) ? task.source_text : [];
}

function isImagePlanItem(item) {
  if (!item || typeof item !== "object") return false;
  const type = String(item.module_type || "").trim();
  if (type === "text_block") return false;
  return Array.isArray(item.image_ids) && item.image_ids.length > 0;
}

function pagesFromExtraction(list, parsed, images) {
  const byKey = sourceIndex(list);
  const taskById = new Map();
  for (const task of parsed.image_tasks || []) {
    const id = String(task.image_id || "").trim();
    if (id) taskById.set(id, task);
  }
  const modules = (parsed.detail_page_plan || []).filter(isImagePlanItem);
  if (modules.length) {
    return modules.map((mod, index) => {
      const ids = Array.isArray(mod.image_ids) ? mod.image_ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
      const names = [];
      const fromTasks = [];
      for (const id of ids) {
        const task = taskById.get(id);
        for (const name of filenamesFromTask(task)) names.push(name);
        fromTasks.push(...taskTexts(task));
      }
      const sources = names.map((name) => byKey.get(lookupKey(name))).filter(Boolean);
      const first = sources[0];
      if (!first) return null;
      const texts = Array.isArray(mod.texts) && mod.texts.length ? mod.texts : fromTasks;
      return {
        id: `page_${String(index + 1).padStart(2, "0")}`,
        page: Number(mod.sequence) || index + 1,
        purpose: mod.purpose || "",
        content: mod.content || "",
        texts,
        image_ids: ids,
        reference_image: first.filename,
        source_images: [...new Set(sources.map((item) => item.id))],
        headline: "",
        subheadline: "",
        display_text: texts,
        design: "",
      };
    }).filter(Boolean);
  }
  return (parsed.pages || []).map((page, index) => {
    const refName = String(page.reference_image || page.filename || "").trim();
    const source = byKey.get(lookupKey(refName));
    if (!source) return null;
    const selected = images.find((image) => image.id === source.id);
    return {
      id: `page_${String(index + 1).padStart(2, "0")}`,
      page: Number(page.page) || index + 1,
      purpose: selected?.visual || `第 ${index + 1} 页`,
      reference_image: source.filename,
      source_images: [source.id],
      headline: "",
      subheadline: "",
      content: [],
      display_text: [],
      design: "",
    };
  }).filter(Boolean);
}

async function extractionPlan({ sources, productId, site, onLog }) {
  const list = (sources || []).slice(0, MAX_DETAIL_IMAGES);
  if (!list.length) throw new Error("没有可分析的详情图");
  const code = String(site || "TH").toUpperCase();
  const market = marketLanguage(site);
  const product = productId || "sku_001";
  const user = EXTRACTION_PLAN_USER_PROMPT
    .replaceAll("{product_id}", product)
    .replaceAll("{platform}", "TikTok Shop")
    .replaceAll("{market}", marketName(site))
    .replaceAll("{language}", market.label)
    .replaceAll("{page_count}", `不固定，按有效信息决定，约 ${MIN_PAGES}–${MAX_PAGES} 页`);
  const content = [{ type: "input_text", text: user }];
  for (const source of list) {
    try {
      fileToDataUri(source.file);
    } catch (error) {
      log(onLog, `跳过过大或无法编码的原图 ${source.filename}：${error.message}`);
      continue;
    }
    content.push({
      type: "input_text",
      text: `filename：${source.filename}\nwidth：${source.width || 0}\nheight：${source.height || 0}`,
    });
    content.push({
      type: "input_image",
      image_url: fileToDataUri(source.file),
      detail: "original",
    });
  }
  if (content.length < 3) throw new Error("详情图无法编码为 OpenAI 图像输入");
  log(onLog, `extract-plan：整组提取并规划详情页 ${list.length} 张 · TikTok ${code}`);
  const result = await createOpenAIResponse({
    input: [
      { role: "system", content: [{ type: "input_text", text: EXTRACTION_PLAN_SYSTEM_PROMPT }] },
      { role: "user", content },
    ],
    temperature: 0.1,
    maxOutputTokens: 16000,
    jsonObject: true,
    logLabel: "详情提取规划-responses",
  });
  const parsed = parseJsonFromModel(result.text);
  const images = imagesFromExtraction(list, parsed);
  const extract = {
    product_id: product || parsed.product_id || "sku_001",
    images,
    image_tasks: Array.isArray(parsed.image_tasks) ? parsed.image_tasks : [],
  };
  const pages = pagesFromExtraction(list, parsed, images);
  if (!pages.length) throw new Error("extract-plan 没有可生成的套图页");
  const plan = {
    product_id: extract.product_id,
    market: code,
    language: market.language,
    aspect_ratio: "1:1",
    image_count: pages.length,
    pages,
    image_tasks: Array.isArray(parsed.image_tasks) ? parsed.image_tasks : [],
    detail_page_plan: Array.isArray(parsed.detail_page_plan) ? parsed.detail_page_plan : [],
  };
  log(onLog, `extract-plan 完成 · ${extract.images.length} 张提取 · ${plan.image_count} 页`, {
    images: extract.images.map((image) => image.filename),
    pages: plan.pages.map((page) => ({ id: page.id, reference_image: page.reference_image, image_ids: page.image_ids || [] })),
  });
  return { extract, plan };
}

const PRODUCT_ANALYSIS_SCHEMA = {
  name: "product_image_analysis",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      source_copy: { type: "array", items: { type: "string" } },
      allowed_target_copy: { type: "array", items: { type: "string" } },
      image_edit_prompt: { type: "string" },
      product_details: { type: "string" },
    },
    required: ["source_copy", "allowed_target_copy", "image_edit_prompt", "product_details"],
  },
};

function uniqueLines(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function additionalCopyFromTexts(texts) {
  return uniqueLines(texts).join(";");
}

function pageRegions(page, tasks, sources) {
  const byName = sourceIndex(sources);
  const taskById = new Map();
  for (const task of tasks || []) {
    const id = String(task.image_id || "").trim();
    if (id) taskById.set(id, task);
  }
  const regions = [];
  for (const id of page.image_ids || []) {
    const task = taskById.get(String(id || "").trim());
    if (!task) throw new Error(`${page.id} 找不到 image_id ${id}`);
    const items = Array.isArray(task.source_regions) ? task.source_regions : [];
    if (!items.length) throw new Error(`${page.id} · ${id} 没有 source_regions`);
    for (const region of items) {
      const filename = String(region.filename || "").trim();
      const source = byName.get(lookupKey(filename));
      if (!source?.file || !fs.existsSync(source.file)) {
        throw new Error(`${page.id} · ${id} 找不到原图 ${filename}`);
      }
      regions.push({
        image_id: id,
        filename: source.filename,
        file: source.file,
        y: Number(region.y) || 0,
        height: Number(region.height) || 0,
      });
    }
  }
  if (regions.length) return regions;
  const fallbackName = String(page.reference_image || "").trim();
  const source = byName.get(lookupKey(fallbackName));
  if (!source?.file) throw new Error(`${page.id} 没有可拼接的 image_ids 或参考图`);
  return [{ image_id: "", filename: source.filename, file: source.file, y: 0, height: 0 }];
}

async function cropRegion(region) {
  const meta = await sharp(region.file).metadata();
  const width = Number(meta.width) || 0;
  const fullHeight = Number(meta.height) || 0;
  if (!width || !fullHeight) throw new Error(`${region.filename} 无法读取尺寸`);
  const top = Math.max(0, Math.min(fullHeight - 1, Math.round(region.y)));
  const height = region.height > 0
    ? Math.max(1, Math.min(fullHeight - top, Math.round(region.height)))
    : fullHeight - top;
  if (height < 1) throw new Error(`${region.filename} 裁切高度无效 y=${region.y} height=${region.height}`);
  return sharp(region.file).extract({ left: 0, top, width, height }).png().toBuffer();
}

async function resizeBuffer(buffer, { width, height, maxSide } = {}) {
  const image = sharp(buffer);
  const meta = await image.metadata();
  const w = Number(meta.width) || 0;
  const h = Number(meta.height) || 0;
  if (!w || !h) return buffer;
  if (maxSide && Math.max(w, h) > maxSide) {
    return image.resize({
      width: w >= h ? maxSide : undefined,
      height: h > w ? maxSide : undefined,
      withoutEnlargement: true,
    }).png().toBuffer();
  }
  if (width && w > width) {
    return image.resize({ width, withoutEnlargement: true }).png().toBuffer();
  }
  if (height && h > height) {
    return image.resize({ height, withoutEnlargement: true }).png().toBuffer();
  }
  return buffer;
}

export async function fitImageFileMaxSide(file, dest, maxSide = MAX_COMPOSE_SIDE) {
  const meta = await sharp(file).metadata();
  const w = Number(meta.width) || 0;
  const h = Number(meta.height) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!w || !h || Math.max(w, h) <= maxSide) {
    if (path.resolve(file) !== path.resolve(dest)) fs.copyFileSync(file, dest);
    return dest;
  }
  const pipeline = sharp(file).resize({
    width: w >= h ? maxSide : undefined,
    height: h > w ? maxSide : undefined,
    withoutEnlargement: true,
  });
  const ext = path.extname(dest).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") await pipeline.jpeg({ quality: 90 }).toFile(dest);
  else if (ext === ".webp") await pipeline.webp({ quality: 90 }).toFile(dest);
  else await pipeline.png().toFile(dest);
  return dest;
}

async function stackVertical(buffers) {
  if (!buffers.length) throw new Error("没有可拼接的图片区域");
  if (buffers.length === 1) return buffers[0];
  const metas = await Promise.all(buffers.map((buf) => sharp(buf).metadata()));
  const width = Math.max(...metas.map((item) => Number(item.width) || 0));
  const aligned = [];
  for (let i = 0; i < buffers.length; i += 1) {
    const currentWidth = Number(metas[i].width) || 0;
    if (currentWidth === width) {
      aligned.push(buffers[i]);
      continue;
    }
    const left = Math.floor((width - currentWidth) / 2);
    aligned.push(await sharp(buffers[i]).extend({
      left,
      right: width - currentWidth - left,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    }).png().toBuffer());
  }
  const heights = await Promise.all(aligned.map(async (buf) => Number((await sharp(buf).metadata()).height) || 0));
  let top = 0;
  const composites = aligned.map((input, index) => {
    const item = { input, top, left: 0 };
    top += heights[index];
    return item;
  });
  return sharp({
    create: {
      width,
      height: top,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).composite(composites).png().toBuffer();
}

async function writeComposedImage(buffer, destPng) {
  fs.writeFileSync(destPng, buffer);
  let analyzeFile = destPng;
  let editFile = destPng;
  if (buffer.length > 4 * 1024 * 1024) {
    analyzeFile = destPng.replace(/\.png$/i, ".analyze.jpg");
    let quality = 85;
    let jpeg = await sharp(buffer).jpeg({ quality }).toBuffer();
    while (jpeg.length > 4 * 1024 * 1024 && quality > 40) {
      quality -= 15;
      jpeg = await sharp(buffer).jpeg({ quality }).toBuffer();
    }
    if (jpeg.length > 4 * 1024 * 1024) {
      jpeg = await sharp(buffer).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    }
    fs.writeFileSync(analyzeFile, jpeg);
  }
  if (buffer.length > MAX_REF_IMAGE_BYTES) {
    editFile = destPng.replace(/\.png$/i, ".edit.jpg");
    const jpeg = await sharp(buffer).jpeg({ quality: 80 }).toBuffer();
    fs.writeFileSync(editFile, jpeg);
    if (jpeg.length > MAX_REF_IMAGE_BYTES) {
      throw new Error(`拼接图过大（${Math.round(jpeg.length / 1024)}KB）`);
    }
  }
  return { composeFile: destPng, analyzeFile, editFile };
}

function detailImageParams(plan, additionalCopy = "") {
  const site = plan.market || "TH";
  const market = marketLanguage(site);
  return {
    platform: "TikTok Shop",
    country: marketName(site),
    language: market.label,
    image_type: "with_text",
    aspect_ratio: plan.aspect_ratio || "1:1",
    excluded_copy: "",
    additional_copy: additionalCopy,
    redesign_strength: "high",
    main_product: "auto",
  };
}

function normalizeComposedAnalysis(parsed, imageType) {
  const type = String(imageType || "with_text").trim() || "with_text";
  const noText = type === "white_background" || type === "no_text";
  const prompt = String(parsed.image_edit_prompt || "").trim();
  if (!prompt) throw new Error("未返回 image_edit_prompt");
  return {
    source_copy: noText ? [] : uniqueLines(parsed.source_copy),
    allowed_target_copy: noText ? [] : uniqueLines(parsed.allowed_target_copy),
    image_edit_prompt: prompt,
    product_details: String(parsed.product_details || "").trim(),
  };
}

async function analyzeComposedImage(file, params, logLabel) {
  const user = DETAIL_IMAGE_ANALYSIS_USER_PROMPT
    .replaceAll("{platform}", params.platform)
    .replaceAll("{country}", params.country)
    .replaceAll("{language}", params.language)
    .replaceAll("{image_type}", params.image_type)
    .replaceAll("{aspect_ratio}", params.aspect_ratio)
    .replaceAll("{excluded_copy}", params.excluded_copy || "")
    .replaceAll("{additional_copy}", params.additional_copy || "")
    .replaceAll("{redesign_strength}", params.redesign_strength)
    .replaceAll("{main_product}", params.main_product);
  const dataUri = fileToDataUri(file);
  const request = {
    input: [
      { role: "system", content: [{ type: "input_text", text: DETAIL_IMAGE_ANALYSIS_SYSTEM_PROMPT }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: user },
          { type: "input_image", image_url: dataUri, detail: "original" },
        ],
      },
    ],
    temperature: 0.1,
    maxOutputTokens: 4096,
    logLabel,
  };
  let result;
  try {
    result = await createOpenAIResponse({ ...request, jsonSchema: PRODUCT_ANALYSIS_SCHEMA });
  } catch (error) {
    const msg = String(error.message || "");
    if (!/json_schema|text\.format|invalid|unknown parameter/i.test(msg)) throw error;
    result = await createOpenAIResponse({ ...request, jsonObject: true });
  }
  let parsed;
  try {
    parsed = parseJsonFromModel(result.text);
  } catch {
    throw new Error(`${path.basename(file)} 分析未返回完整 JSON`);
  }
  return normalizeComposedAnalysis(parsed, params.image_type);
}

function selectPages(plan, pageId = "") {
  const wanted = String(pageId || "").trim();
  const pages = wanted ? (plan.pages || []).filter((page) => page.id === wanted) : (plan.pages || []);
  if (wanted && !pages.length) throw new Error(`plan 里没有 ${wanted}`);
  if (!pages.length) throw new Error("缺少 plan.pages");
  return pages;
}

async function composePageImage(page, tasks, sources, destPng, onLog) {
  const regions = pageRegions(page, tasks, sources);
  log(onLog, `compose：${page.id} · ${regions.length} 段 · ${page.image_ids?.join("、") || page.reference_image}`);
  const strips = [];
  for (const region of regions) {
    const cropped = await cropRegion(region);
    strips.push(await resizeBuffer(cropped, { maxSide: MAX_COMPOSE_SIDE }));
  }
  const stacked = strips.length > 1 ? await stackVertical(strips) : strips[0];
  const composed = await resizeBuffer(stacked, { width: MAX_COMPOSE_WIDTH });
  return writeComposedImage(composed, destPng);
}

export async function composeDetailImages({ plan, extract, files = [], urls = [], outputDir = "", pageId = "", onLog } = {}) {
  const sources = mapSourceFiles(files, urls);
  if (!sources.length) throw new Error("没有可拆分的原图");
  if (!plan?.pages?.length) throw new Error("缺少 plan");
  const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), "miaoshou-tkshop-compose-"));
  fs.mkdirSync(dir, { recursive: true });
  const tasks = extract?.image_tasks || plan.image_tasks || [];
  const pages = selectPages(plan, pageId);
  const composed = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const stem = String(index + 1).padStart(2, "0");
    const composeFile = path.join(dir, `${stem}.compose.png`);
    await composePageImage(page, tasks, sources, composeFile, onLog);
    composed.push({
      page: page.id,
      image_ids: page.image_ids || [],
      file: composeFile,
    });
    log(onLog, `${page.id} 已拼接 ${composeFile}`);
  }
  return { dir, files: composed.map((item) => item.file), pages: composed };
}

async function generate({ plan, extract, sources, outputDir, onLog, pageId = "" }) {
  const cfg = openaiConfig();
  fs.mkdirSync(outputDir, { recursive: true });
  const pages = selectPages(plan, pageId);
  const tasks = extract?.image_tasks || plan.image_tasks || [];
  const files = [];
  const pageResults = [];
  for (const page of pages) {
    const stem = String(files.length + 1).padStart(2, "0");
    const composeFile = path.join(outputDir, `${stem}.compose.png`);
    const { analyzeFile, editFile } = await composePageImage(page, tasks, sources, composeFile, onLog);
    const additionalCopy = additionalCopyFromTexts(page.texts || page.display_text);
    const params = detailImageParams(plan, additionalCopy);
    log(onLog, `generate-analyze：${page.id} · 拼图 ${path.basename(analyzeFile)}`, params);
    const analysis = await analyzeComposedImage(analyzeFile, params, `详情套图分析-${page.id}-responses`);
    log(onLog, `generate：${page.id} · image2 · ${path.basename(editFile)}`, analysis);
    try {
      const generated = await editImageWithReferences({
        prompt: analysis.image_edit_prompt,
        files: [editFile],
        size: cfg.imageSize || "1024x1024",
        logLabel: `详情套图-${page.id}-images-edits`,
      });
      const dest = path.join(outputDir, `${stem}.png`);
      await saveGeneratedImage(generated, dest);
      fs.writeFileSync(path.join(outputDir, `${stem}.prompt.txt`), `${analysis.image_edit_prompt}\n`, "utf8");
      fs.writeFileSync(path.join(outputDir, `${stem}.analysis.json`), `${JSON.stringify({
        page: page.id,
        image_ids: page.image_ids || [],
        compose: path.basename(composeFile),
        params,
        ...analysis,
      }, null, 2)}\n`, "utf8");
      files.push(dest);
      pageResults.push({
        page: page.id,
        file: dest,
        productDetails: analysis.product_details || "",
      });
      log(onLog, `${page.id} 已保存 ${dest}`);
    } catch (error) {
      log(onLog, `${page.id} 生图失败：${error.message}`, error.detail || "");
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!files.length) throw new Error("generate 没有生成任何详情图");
  return { files, pages: pageResults };
}

export async function runOpenAIDetailFlow({ files = [], urls = [], site = "TH", productId = "", onLog } = {}) {
  const sources = mapSourceFiles(files, urls);
  if (!sources.length) throw new Error("没有可分析的详情图");
  const { extract, plan: detailPlan } = await extractionPlan({ sources, productId, site, onLog });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "miaoshou-tkshop-api-"));
  const generated = await generate({ plan: detailPlan, extract, sources, outputDir, onLog });
  return {
    extract,
    plan: detailPlan,
    dir: outputDir,
    files: generated.files,
    pages: generated.pages || [],
  };
}

export async function extractionPlanDetailImages({ files = [], urls = [], productId = "", site = "TH", onLog } = {}) {
  const sources = mapSourceFiles(files, urls);
  if (!sources.length) throw new Error("没有可分析的详情图");
  return extractionPlan({ sources, productId, site, onLog });
}

export async function analyzeDetailImages({ files = [], urls = [], productId = "", site = "TH", onLog } = {}) {
  const { extract } = await extractionPlanDetailImages({ files, urls, productId, site, onLog });
  return extract;
}

export async function planDetailImages({ files = [], urls = [], productId = "", extract, site = "TH", onLog } = {}) {
  const { plan } = await extractionPlanDetailImages({
    files,
    urls,
    productId: productId || extract?.product_id || "",
    site,
    onLog,
  });
  return plan;
}

export async function generateDetailImages({ plan, extract, files = [], urls = [], outputDir = "", pageId = "", onLog } = {}) {
  const sources = mapSourceFiles(files, urls);
  if (!sources.length) throw new Error("没有可生图的原图");
  if (!plan?.pages?.length) throw new Error("缺少 plan");
  const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), "miaoshou-tkshop-api-"));
  const generated = await generate({ plan, extract, sources, outputDir: dir, onLog, pageId });
  return { dir, files: generated.files, pages: generated.pages || [] };
}
