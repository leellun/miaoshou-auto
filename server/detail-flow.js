import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  DETAIL_COPY_PROMPT,
  DETAIL_IMAGE_ANALYSIS_SYSTEM_PROMPT,
  DETAIL_IMAGE_ANALYSIS_USER_PROMPT,
  EXTRACTION_PLAN_SYSTEM_PROMPT,
  EXTRACTION_PLAN_USER_PROMPT,
} from "./tkshop-prompts.js";

const MIN_PAGES = 3;
const MAX_PAGES = 10;

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

export function mapSourceFiles(files = [], urls = []) {
  return (files || []).filter((file) => file && fs.existsSync(file)).map((file, index) => ({
    id: imageId(index),
    source_id: `S${String(index + 1).padStart(3, "0")}`,
    filename: path.basename(file),
    file,
    url: urls[index] || "",
  }));
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

function normalizeCopyList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const clean = String(value || "").trim().replace(/^[-•]\s*/, "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export function detailCopyToText(copy, language = "zh") {
  const labels = {
    zh: ["产品特性", "规格参数", "注意事项"],
    en: ["Product Features", "Specifications", "Notes"],
    th: ["คุณสมบัติของสินค้า", "ข้อมูลจำเพาะ", "หมายเหตุ"],
    id: ["Fitur Produk", "Spesifikasi", "Catatan"],
  };
  const [featureLabel, specLabel, noteLabel] = labels[language] || labels.zh;
  const lines = [featureLabel];
  (copy.product_features || []).forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  lines.push("", specLabel);
  for (const item of copy.specifications || []) lines.push(`- ${item}`);
  lines.push("", noteLabel);
  for (const item of copy.notes || []) lines.push(`- ${item}`);
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

export async function generateDetailCopy({ extract, onLog } = {}) {
  log(onLog, "detail：生成中文文字版商品详情");
  const result = await createOpenAIResponse({
    input: [
      { role: "system", content: DETAIL_COPY_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          detail_copy_language: "zh",
          product_profile: extract,
        }),
      },
    ],
    temperature: 0.2,
    maxOutputTokens: 4000,
    jsonObject: true,
    logLabel: "详情文字-responses",
  });
  const parsed = parseJsonFromModel(result.text);
  const copy = {
    product_features: normalizeCopyList(parsed.product_features),
    specifications: normalizeCopyList(parsed.specifications),
    notes: normalizeCopyList(parsed.notes),
  };
  if (!copy.product_features.length && !copy.specifications.length) {
    throw new Error("未返回文字版商品详情");
  }
  const text = detailCopyToText(copy, "zh");
  log(onLog, "detail 完成", text.slice(0, 400));
  return { copy, text };
}

export function listingCopyFromExtract(extract) {
  const points = [];
  const specs = [];
  for (const image of extract?.images || []) {
    for (const text of image.text || []) points.push(text);
    for (const [name, values] of Object.entries(image.specs || {})) {
      if (Array.isArray(values)) specs.push(`${name}：${values.join("、")}`);
    }
    for (const [name, mapping] of Object.entries(image.spec_entries || {})) {
      const parts = Object.entries(mapping).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join("、") : value}`);
      if (parts.length) specs.push(`${name}：${parts.join("；")}`);
    }
  }
  const featureLines = unique(points).slice(0, 7);
  const specLines = unique(specs).slice(0, 8);
  const lines = ["产品特性"];
  featureLines.forEach((line, index) => lines.push(`${index + 1}. ${line}`));
  if (specLines.length) {
    lines.push("", "规格参数");
    for (const line of specLines) lines.push(`- ${line}`);
  }
  lines.push("", "注意事项", "- 尺寸为图示参考，下单前请按实际需求核对。");
  return lines.join("\n");
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
      text: `下一张图片元数据：filename=${source.filename}`,
    });
    content.push({
      type: "input_image",
      image_url: fileToDataUri(source.file),
      detail: "original",
    });
  }
  if (content.length < 3) throw new Error("详情图无法编码为 OpenAI 图像输入");
  log(onLog, `extract-plan：整组提取并筛选参考图 ${list.length} 张 · TikTok ${code}`);
  const result = await createOpenAIResponse({
    input: [
      { role: "system", content: [{ type: "input_text", text: EXTRACTION_PLAN_SYSTEM_PROMPT }] },
      { role: "user", content },
    ],
    temperature: 0.1,
    maxOutputTokens: 8000,
    jsonObject: true,
    logLabel: "详情提取规划-responses",
  });
  const parsed = parseJsonFromModel(result.text);
  const byKey = new Map();
  for (const image of parsed.images || []) {
    const converted = convertSpecItems(image.spec_items);
    const specs = image.specs && typeof image.specs === "object" && Object.keys(image.specs).length
      ? image.specs
      : converted.specs;
    const specEntries = image.spec_entries && typeof image.spec_entries === "object" && Object.keys(image.spec_entries).length
      ? image.spec_entries
      : converted.spec_entries;
    const record = {
      id: String(image.id || image.image_id || "").trim(),
      source_id: image.source_id || "",
      filename: image.filename || "",
      text: Array.isArray(image.text) ? image.text : [],
      specs,
      spec_entries: specEntries,
      visual: image.visual || "",
      unclear: Array.isArray(image.unclear) ? image.unclear : [],
    };
    for (const key of [record.filename, record.id, record.source_id]) {
      if (key) byKey.set(lookupKey(key), record);
    }
  }
  const images = list.map((source) => {
    const record = byKey.get(lookupKey(source.filename))
      || byKey.get(lookupKey(source.id))
      || byKey.get(lookupKey(source.source_id))
      || {};
    return compactImage({
      ...record,
      id: source.id,
      source_id: source.source_id,
      filename: source.filename,
    });
  });
  const extract = { product_id: product || parsed.product_id || "sku_001", images };
  const sourceByKey = new Map();
  for (const source of list) {
    for (const key of [source.filename, source.id, source.source_id]) {
      if (key) sourceByKey.set(lookupKey(key), source);
    }
  }
  const pages = (parsed.pages || []).map((page, index) => {
    const refName = String(page.reference_image || page.filename || "").trim();
    const source = sourceByKey.get(lookupKey(refName));
    if (!source) return null;
    const selected = images.find((image) => image.id === source.id);
    const number = Number(page.page) || index + 1;
    return {
      id: `page_${String(index + 1).padStart(2, "0")}`,
      page: number,
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
  if (!pages.length) throw new Error("extract-plan 没有可生成的套图页");
  const plan = {
    product_id: extract.product_id,
    market: code,
    language: market.language,
    aspect_ratio: "1:1",
    image_count: pages.length,
    pages,
  };
  log(onLog, `extract-plan 完成 · ${extract.images.length} 张提取 · ${plan.image_count} 页`, {
    images: extract.images.map((image) => image.filename),
    pages: plan.pages.map((page) => ({ id: page.id, reference_image: page.reference_image })),
  });
  return { extract, plan };
}

const DETAIL_IMAGE_ANALYSIS_SCHEMA = {
  name: "detail_image_analysis",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      source_copy: { type: "array", items: { type: "string" } },
      excluded_copy: { type: "array", items: { type: "string" } },
      allowed_target_copy: { type: "array", items: { type: "string" } },
      image_edit_prompt: { type: "string" },
    },
    required: ["source_copy", "excluded_copy", "allowed_target_copy", "image_edit_prompt"],
  },
};

function resolvePageSource(page, sources) {
  const byId = new Map((sources || []).map((item) => [item.id, item]));
  const byName = new Map((sources || []).map((item) => [lookupKey(item.filename), item]));
  const refName = String(page.reference_image || "").trim();
  if (refName && byName.has(lookupKey(refName))) return byName.get(lookupKey(refName));
  for (const id of page.source_images || []) {
    if (byId.has(id)) return byId.get(id);
  }
  return null;
}

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

function normalizeDetailImageAnalysis(parsed, imageType) {
  const type = String(imageType || "with_text").trim() || "with_text";
  const noText = type === "white_background" || type === "no_text";
  const prompt = String(parsed.image_edit_prompt || "").trim();
  if (!prompt) throw new Error("未返回 image_edit_prompt");
  return {
    source_copy: noText ? [] : uniqueLines(parsed.source_copy),
    excluded_copy: uniqueLines(parsed.excluded_copy),
    allowed_target_copy: noText ? [] : uniqueLines(parsed.allowed_target_copy),
    image_edit_prompt: prompt,
  };
}

function detailImageParams(plan) {
  const site = plan.market || "TH";
  const market = marketLanguage(site);
  return {
    platform: "TikTok Shop",
    country: marketName(site),
    language: market.label,
    image_type: "with_text",
    aspect_ratio: plan.aspect_ratio || "1:1",
    excluded_copy: "",
    redesign_strength: "medium",
    main_product: "auto",
  };
}

async function analyzeDetailPageImage(source, params) {
  const user = DETAIL_IMAGE_ANALYSIS_USER_PROMPT
    .replaceAll("{platform}", params.platform)
    .replaceAll("{country}", params.country)
    .replaceAll("{language}", params.language)
    .replaceAll("{image_type}", params.image_type)
    .replaceAll("{aspect_ratio}", params.aspect_ratio)
    .replaceAll("{excluded_copy}", params.excluded_copy)
    .replaceAll("{redesign_strength}", params.redesign_strength)
    .replaceAll("{main_product}", params.main_product);
  const dataUri = fileToDataUri(source.file);
  const input = [
    { role: "system", content: [{ type: "input_text", text: DETAIL_IMAGE_ANALYSIS_SYSTEM_PROMPT }] },
    {
      role: "user",
      content: [
        { type: "input_text", text: user },
        { type: "input_image", image_url: dataUri, detail: "original" },
      ],
    },
  ];
  const request = {
    input,
    temperature: 0.1,
    maxOutputTokens: 4096,
    logLabel: `详情套图分析-${source.filename}-responses`,
  };
  let result;
  try {
    result = await createOpenAIResponse({ ...request, jsonSchema: DETAIL_IMAGE_ANALYSIS_SCHEMA });
  } catch (error) {
    const msg = String(error.message || "");
    if (!/json_schema|text\.format|invalid|unknown parameter/i.test(msg)) throw error;
    result = await createOpenAIResponse({ ...request, jsonObject: true });
  }
  let parsed;
  try {
    parsed = parseJsonFromModel(result.text);
  } catch {
    throw new Error(`${source.filename} 分析未返回完整 JSON`);
  }
  return normalizeDetailImageAnalysis(parsed, params.image_type);
}

async function generate({ plan, sources, outputDir, onLog, pageId = "" }) {
  const cfg = openaiConfig();
  fs.mkdirSync(outputDir, { recursive: true });
  const wanted = String(pageId || "").trim();
  const pages = wanted ? (plan.pages || []).filter((page) => page.id === wanted) : (plan.pages || []);
  if (wanted && !pages.length) throw new Error(`plan 里没有 ${wanted}`);
  const params = detailImageParams(plan);
  const files = [];
  for (const page of pages) {
    const source = resolvePageSource(page, sources);
    if (!source?.file || !fs.existsSync(source.file)) {
      throw new Error(`${page.id} 没有可用参考图 ${page.reference_image || (page.source_images || []).join("、")}`);
    }
    const stat = fs.statSync(source.file);
    if (stat.size > MAX_REF_IMAGE_BYTES) {
      throw new Error(`${page.id} 参考图过大（${Math.round(stat.size / 1024)}KB）`);
    }
    log(onLog, `generate-analyze：${page.id} · ${source.filename}`, params);
    const analysis = await analyzeDetailPageImage(source, params);
    log(onLog, `generate：${page.id} · image2 · ${source.filename}`, analysis);
    try {
      const generated = await editImageWithReferences({
        prompt: analysis.image_edit_prompt,
        files: [source.file],
        size: cfg.imageSize || "1024x1024",
        logLabel: `详情套图-${page.id}-images-edits`,
      });
      const stem = String(files.length + 1).padStart(2, "0");
      const dest = path.join(outputDir, `${stem}.png`);
      const promptFile = path.join(outputDir, `${stem}.prompt.txt`);
      const analysisFile = path.join(outputDir, `${stem}.analysis.json`);
      await saveGeneratedImage(generated, dest);
      fs.writeFileSync(promptFile, `${analysis.image_edit_prompt}\n`, "utf8");
      fs.writeFileSync(analysisFile, `${JSON.stringify({
        page: page.id,
        reference_image: source.filename,
        params,
        ...analysis,
      }, null, 2)}\n`, "utf8");
      files.push(dest);
      log(onLog, `${page.id} 已保存 ${dest}，提示词 ${promptFile}`);
    } catch (error) {
      log(onLog, `${page.id} 生图失败：${error.message}`, error.detail || "");
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!files.length) throw new Error("generate 没有生成任何详情图");
  return files;
}

export async function runOpenAIDetailFlow({ files = [], urls = [], site = "TH", productId = "", onLog } = {}) {
  const sources = mapSourceFiles(files, urls);
  if (!sources.length) throw new Error("没有可分析的详情图");
  const { extract, plan: detailPlan } = await extractionPlan({ sources, productId, site, onLog });
  const detail = await generateDetailCopy({ extract, onLog });
  const listingCopy = detail.text;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "miaoshou-tkshop-api-"));
  const generatedFiles = await generate({ plan: detailPlan, extract, sources, outputDir, onLog });
  return {
    extract,
    plan: detailPlan,
    listingCopy,
    dir: outputDir,
    files: generatedFiles,
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
  return { dir, files: generated };
}
