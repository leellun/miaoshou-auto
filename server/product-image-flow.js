import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createOpenAIResponse,
  editImageWithReferences,
  fileToDataUri,
  marketLanguage,
  openaiConfig,
  parseJsonFromModel,
  saveGeneratedImage,
} from "./openai-api.js";
import { fitImageFileMaxSide, mapSourceFiles } from "./detail-flow.js";

const MAX_PRODUCT_INPUT_SIDE = 1024;
import {
  PRODUCT_IMAGE_SYSTEM_PROMPT,
  PRODUCT_IMAGE_USER_PROMPT_TEMPLATE,
} from "./tkshop-prompts.js";

const PRODUCT_ANALYSIS_SCHEMA = {
  name: "product_image_analysis",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      source_copy: { type: "array", items: { type: "string" } },
      allowed_target_copy: { type: "array", items: { type: "string" } },
      image_edit_prompt: { type: "string" },
    },
    required: ["source_copy", "allowed_target_copy", "image_edit_prompt"],
  },
};

function log(onLog, message, extra) {
  onLog?.(message, extra);
}

function countryName(site) {
  const code = String(site || "TH").toUpperCase();
  if (code === "MY") return "马来西亚";
  if (code === "PH") return "菲律宾";
  return "泰国";
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

function hasOwnParams(params = {}) {
  return Boolean(
    params.platform
    || params.country
    || params.language
    || params.aspect_ratio
    || params.image_type
    || (params.excluded_copy != null && String(params.excluded_copy) !== ""),
  );
}

export function productImageFlags({ imageKind = "main", index = 0, params = {} } = {}) {
  const custom = hasOwnParams(params);
  const whiteBackground = !custom && imageKind === "main" && Number(index) === 0;
  const imageType = String(params.image_type || "").trim();
  const allowedType = ["with_text", "white_background", "no_text"].includes(imageType) ? imageType : "";
  return {
    image_type: allowedType || (whiteBackground ? "white_background" : "with_text"),
    aspect_ratio: String(params.aspect_ratio || "").trim() || "1:1",
    excluded_copy: String(params.excluded_copy || "").trim(),
  };
}

export function buildProductImagePrompt({ site = "TH", imageKind = "main", index = 0, params = {} } = {}) {
  const market = marketLanguage(site);
  const flags = productImageFlags({ imageKind, index, params });
  const platform = String(params.platform || "").trim() || "TikTok Shop";
  const country = String(params.country || "").trim() || countryName(site);
  const language = String(params.language || "").trim() || market.label;
  const user = PRODUCT_IMAGE_USER_PROMPT_TEMPLATE
    .replaceAll("{platform}", platform)
    .replaceAll("{country}", country)
    .replaceAll("{language}", language)
    .replaceAll("{aspect_ratio}", flags.aspect_ratio)
    .replaceAll("{image_type}", flags.image_type)
    .replaceAll("{excluded_copy}", flags.excluded_copy);
  return {
    system: PRODUCT_IMAGE_SYSTEM_PROMPT,
    user,
    flags: {
      platform,
      country,
      language,
      ...flags,
    },
  };
}

function sizeForAspect(ratio) {
  const value = String(ratio || "1:1");
  if (["3:4", "4:5", "9:16"].includes(value)) return "1024x1536";
  if (["4:3", "5:4", "16:9"].includes(value)) return "1536x1024";
  return "";
}

function normalizeAnalysis(parsed, flags) {
  const noText = flags.image_type === "white_background" || flags.image_type === "no_text";
  const prompt = String(parsed.image_edit_prompt || "").trim();
  if (!prompt) throw new Error("未返回 image_edit_prompt");
  return {
    source_copy: uniqueLines(parsed.source_copy),
    allowed_target_copy: noText ? [] : uniqueLines(parsed.allowed_target_copy),
    image_edit_prompt: prompt,
  };
}

async function analyzeProductImage(source, { site, imageKind, index, params }) {
  const { system, user, flags } = buildProductImagePrompt({ site, imageKind, index, params });
  const dataUri = fileToDataUri(source.file);
  const input = [
    { role: "system", content: [{ type: "input_text", text: system }] },
    {
      role: "user",
      content: [
        { type: "input_text", text: user },
        { type: "input_image", image_url: dataUri, detail: "original" },
      ],
    },
  ];
  const kind = imageKind === "sku" ? "SKU" : "主图";
  const request = {
    input,
    temperature: 0.1,
    maxOutputTokens: 4096,
    logLabel: `${kind}分析-${source.filename}-responses`,
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
    throw new Error(`${source.filename} 分析未返回完整 JSON`);
  }
  return { analysis: normalizeAnalysis(parsed, flags), flags };
}

async function productGenerate({ sources, site, imageKind, outputDir, onLog, onlyFilename = "", params = {} }) {
  const cfg = openaiConfig();
  fs.mkdirSync(outputDir, { recursive: true });
  const kind = imageKind === "sku" ? "sku" : "main";
  const wanted = String(onlyFilename || "").trim().toLowerCase();
  const items = wanted
    ? (sources || []).filter((item) => String(item.filename || "").toLowerCase() === wanted)
    : (sources || []);
  if (wanted && !items.length) throw new Error(`没有 ${onlyFilename}`);
  const files = [];
  const report = [];
  for (let index = 0; index < items.length; index += 1) {
    const source = items[index];
    const dest = path.join(outputDir, `${String(index + 1).padStart(3, "0")}.png`);
    if (!source?.file || !fs.existsSync(source.file)) {
      const err = new Error(`${source?.filename || "源图"} 不存在`);
      err.detail = report;
      throw err;
    }
    const originalIndex = Math.max(0, sources.indexOf(source));
    const stem = path.join(outputDir, String(index + 1).padStart(3, "0"));
    const inputFile = `${stem}.input.png`;
    await fitImageFileMaxSide(source.file, inputFile, MAX_PRODUCT_INPUT_SIDE);
    const inputSource = { ...source, file: inputFile };
    log(onLog, `product-analyze：${index + 1}/${items.length} ${source.filename}`);
    let analysis;
    let flags;
    try {
      ({ analysis, flags } = await analyzeProductImage(inputSource, {
        site,
        imageKind: kind,
        index: originalIndex,
        params,
      }));
    } catch (error) {
      const err = new Error(`${source.filename} 分析失败：${error.message}`);
      err.detail = report;
      throw err;
    }
    log(onLog, `product-generate：${index + 1}/${items.length} ${source.filename}`, {
      ...flags,
      ...analysis,
    });
    try {
      const generated = await editImageWithReferences({
        prompt: analysis.image_edit_prompt,
        files: [inputFile],
        size: sizeForAspect(flags.aspect_ratio) || cfg.imageSize || "1024x1024",
        logLabel: `${kind === "sku" ? "SKU" : "主图"}生图-${source.filename}-images-edits`,
      });
      await saveGeneratedImage(generated, dest);
      fs.writeFileSync(`${stem}.prompt.txt`, `${analysis.image_edit_prompt}\n`, "utf8");
      fs.writeFileSync(`${stem}.analysis.json`, `${JSON.stringify({
        filename: source.filename,
        ...flags,
        ...analysis,
      }, null, 2)}\n`, "utf8");
      files.push(dest);
      report.push({
        source_id: source.source_id,
        filename: source.filename,
        status: "passed",
        output_file: dest,
        ...flags,
        ...analysis,
      });
    } catch (error) {
      report.push({
        source_id: source.source_id,
        filename: source.filename,
        status: "failed",
        reason: error.message,
        ...flags,
        ...analysis,
      });
      const err = new Error(`${source.filename} 生图失败：${error.message}`);
      err.detail = report;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (files.length !== items.length) {
    const reasons = report
      .filter((row) => row.status !== "passed")
      .map((row) => `${row.filename}: ${row.reason || row.status}`)
      .join("；");
    const err = new Error(`商品图批处理存在未完成图片${reasons ? `：${reasons}` : ""}`);
    err.detail = report;
    throw err;
  }
  return { files, report };
}

export async function runProductImageFlow({ files = [], urls = [], site = "TH", imageKind = "main", params = {}, onLog } = {}) {
  const kind = imageKind === "sku" ? "sku" : "main";
  const sources = mapSourceFiles(files, urls);
  if (!sources.length) throw new Error(kind === "sku" ? "没有可处理的 SKU 图" : "没有可处理的商品主图");
  log(onLog, `product_run：${kind} · analyze → image2 · ${sources.length} 张`);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `miaoshou-${kind}-api-`));
  const generated = await productGenerate({ sources, site, imageKind: kind, outputDir, onLog, params });
  log(onLog, `product-generate 完成 · ${generated.files.length} 张`);
  return {
    kind,
    dir: outputDir,
    files: generated.files,
    report: generated.report,
  };
}

export async function runProductGenerate({
  files = [],
  urls = [],
  site = "TH",
  imageKind = "main",
  outputDir = "",
  onlyFilename = "",
  params = {},
  onLog,
} = {}) {
  const kind = imageKind === "sku" ? "sku" : "main";
  const sources = mapSourceFiles(files, urls);
  if (!sources.length) throw new Error(kind === "sku" ? "没有可处理的 SKU 图" : "没有可处理的商品主图");
  const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), "miaoshou-product-api-"));
  return productGenerate({ sources, site, imageKind: kind, outputDir: dir, onLog, onlyFilename, params });
}
