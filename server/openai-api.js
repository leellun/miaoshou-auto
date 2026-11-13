import fs from "node:fs";
import path from "node:path";
import { Blob } from "node:buffer";
import undici from "undici";
import { TITLE_GENERATION_SYSTEM_PROMPT, TITLE_GENERATION_USER_PROMPT_TEMPLATE } from "./tkshop-prompts.js";
import { snapshotRequestBody, writeOpenAILog } from "./openai-log.js";
import { readStore } from "./store.js";

const { ProxyAgent, fetch: undiciFetch, FormData } = undici;

const TITLE_MIN_CHARS = 25;
const TITLE_MAX_CHARS = 255;
const MAX_DETAIL_IMAGES = 10;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_REF_IMAGE_BYTES = 18 * 1024 * 1024;

export function marketLabel(site) {
  const code = String(site || "TH").toUpperCase();
  if (code === "MY") return "马来西亚站中文";
  if (code === "PH") return "菲律宾站中文";
  return "泰国站中文";
}

export function marketLanguage(site) {
  const code = String(site || "TH").toUpperCase();
  if (code === "MY") return { language: "ms", label: "马来语" };
  if (code === "PH") return { language: "en", label: "英语" };
  return { language: "th", label: "泰语" };
}

export { MAX_DETAIL_IMAGES, MAX_REF_IMAGE_BYTES };

export function openaiConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const baseUrl = String(process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
  const model = String(process.env.OPENAI_MODEL || "gpt-4.1").trim();
  return {
    apiKey,
    baseUrl,
    model,
    imageModel: String(process.env.OPENAI_IMAGE_MODEL || "gpt-image-2").trim(),
    imageSize: String(process.env.OPENAI_IMAGE_SIZE || "1024x1024").trim(),
    imageQuality: String(process.env.OPENAI_IMAGE_QUALITY || "high").trim(),
    responsesUrl: `${baseUrl}/v1/responses`,
    imageEditsUrl: `${baseUrl}/v1/images/edits`,
    imageGenerationsUrl: `${baseUrl}/v1/images/generations`,
  };
}

export function hasOpenAIConfig() {
  return Boolean(openaiConfig().apiKey);
}

function mimeFromFile(file) {
  const ext = path.extname(file || "").toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

export function openaiImageSize(size) {
  const raw = String(size || "").trim().toLowerCase();
  if (/^\d+x\d+$/.test(raw)) return raw;
  if (raw === "1:1") return "1024x1024";
  if (["3:2", "4:3", "16:9", "5:4", "2:1"].includes(raw)) return "1536x1024";
  return "1024x1536";
}

export function fileToDataUri(file, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  const buf = fs.readFileSync(file);
  if (buf.length > maxBytes) {
    throw new Error(`图片过大（${Math.round(buf.length / 1024)}KB）：${path.basename(file)}`);
  }
  return `data:${mimeFromFile(file)};base64,${buf.toString("base64")}`;
}

export function parseJsonFromModel(text) {
  const raw = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!raw) throw new Error("模型没有返回 JSON 对象");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // 截取第一个能闭合的 JSON 对象
  }
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inStr) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("模型没有返回完整 JSON 对象");
}

function walkOutputParts(payload, visit) {
  const roots = [
    payload,
    payload?.response,
    ...(Array.isArray(payload?.output) ? payload.output : []),
    ...(Array.isArray(payload?.choices) ? payload.choices : []),
  ];
  for (const item of roots) {
    if (!item || typeof item !== "object") continue;
    visit(item);
    const contents = item.content || item.message?.content;
    if (Array.isArray(contents)) {
      for (const part of contents) visit(part);
    }
  }
}

export function extractResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    const direct = payload.output_text.trim();
    try {
      parseJsonFromModel(direct);
      return direct;
    } catch {
      // 再从分片里找完整 JSON
    }
  }
  const chunks = [];
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    chunks.push(payload.output_text.trim());
  }
  walkOutputParts(payload, (part) => {
    if (typeof part === "string" && part.trim()) chunks.push(part.trim());
    const text = part?.text || part?.output_text || part?.refusal || "";
    if (text && typeof text === "string") chunks.push(text.trim());
    if (part?.parsed && typeof part.parsed === "object") chunks.push(JSON.stringify(part.parsed));
    if (typeof part?.content === "string" && part.content.trim()) chunks.push(part.content.trim());
  });
  const unique = [...new Set(chunks.filter(Boolean))];
  for (const chunk of unique) {
    if (!chunk.includes("{")) continue;
    try {
      parseJsonFromModel(chunk);
      return chunk;
    } catch {
      // 下一片
    }
  }
  return unique.join("\n").trim();
}

function titleLength(text) {
  return [...String(text || "").trim()].length;
}

function finalizeTitle(optimized, original) {
  let title = String(optimized || "").replace(/\s+/g, " ").trim();
  const source = String(original || "").replace(/\s+/g, " ").trim();
  if (titleLength(title) < TITLE_MIN_CHARS && source && title && !source.includes(title)) {
    title = `${title} ${source}`.replace(/\s+/g, " ").trim();
  }
  if (titleLength(title) < TITLE_MIN_CHARS && titleLength(source) >= TITLE_MIN_CHARS) {
    title = source;
  }
  if (titleLength(title) < TITLE_MIN_CHARS) {
    throw new Error(`商品标题不足 ${TITLE_MIN_CHARS} 个字符（当前 ${titleLength(title)}）：${title}`);
  }
  if (titleLength(title) > TITLE_MAX_CHARS) {
    title = [...title].slice(0, TITLE_MAX_CHARS).join("").trim();
  }
  return title;
}

function pickOptimizedTitle(parsed) {
  const skip = new Set(["original_title", "marketplace_region", "output_language", "input", "request"]);
  const keys = [
    "optimized_title",
    "optimizedTitle",
    "localized_title",
    "product_title",
    "marketplace_title",
    "output_title",
    "title",
  ];
  const visit = (value, depth = 0) => {
    if (value == null || depth > 4) return "";
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = visit(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    if (typeof value !== "object") return "";
    for (const key of keys) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
    for (const [key, child] of Object.entries(value)) {
      if (skip.has(key)) continue;
      const hit = visit(child, depth + 1);
      if (hit) return hit;
    }
    return "";
  };
  return visit(parsed);
}

export async function createOpenAIResponse({ input, temperature = 0.2, maxOutputTokens = 4096, jsonObject = false, jsonSchema = null, logLabel = "" } = {}) {
  const { model, responsesUrl } = openaiConfig();
  const body = {
    model,
    input,
    max_output_tokens: maxOutputTokens,
    stream: false,
  };
  if (jsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: jsonSchema.name || "result",
        strict: true,
        schema: jsonSchema.schema,
      },
    };
  } else if (jsonObject) {
    body.text = { format: { type: "json_object" } };
  }
  if (!/^gpt-5/i.test(model) && !/^gpt-6/i.test(model)) body.temperature = temperature;
  const data = await openaiFetch(responsesUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    logLabel,
  });
  const text = extractResponseText(data);
  if (!text) {
    const reason = data.status === "incomplete"
      ? `OpenAI 输出被截断：${data.incomplete_details?.reason || "incomplete"}`
      : "OpenAI 没有返回文本";
    const err = new Error(reason);
    err.detail = data;
    throw err;
  }
  return { text, data, model, status: data.status || "", incomplete: data.incomplete_details || null };
}

export async function generateTitle({ originalTitle, site = "TH" } = {}) {
  const title = String(originalTitle || "").trim();
  if (!title) return "";
  const code = String(site || "TH").toUpperCase();
  const country = code === "MY" ? "马来西亚" : code === "PH" ? "菲律宾" : "泰国";
  const user = TITLE_GENERATION_USER_PROMPT_TEMPLATE
    .replaceAll("{platform}", "TikTok Shop")
    .replaceAll("{country}", country)
    .replaceAll("{original_title}", title);
  const input = [
    { role: "system", content: [{ type: "input_text", text: TITLE_GENERATION_SYSTEM_PROMPT }] },
    { role: "user", content: [{ type: "input_text", text: user }] },
  ];
  const result = await createOpenAIResponse({
    input,
    temperature: 0.3,
    maxOutputTokens: 2048,
    logLabel: "标题优化-responses",
  });
  let optimized = String(result.text || "")
    .replace(/\s+/g, " ")
    .replace(/^["「『“'`]+|["」』”'`]+$/g, "")
    .trim();
  if (optimized.startsWith("{")) {
    try {
      optimized = pickOptimizedTitle(parseJsonFromModel(optimized))
        .replace(/\s+/g, " ")
        .replace(/^["「『“'`]+|["」』”'`]+$/g, "")
        .trim();
    } catch {
      // 按纯文本标题处理
    }
  }
  if (!optimized) {
    const preview = String(result.text || "").replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`未返回商品标题${preview ? `：${preview}` : ""}`);
  }
  return finalizeTitle(optimized, title);
}

export function openaiProxyUrl() {
  let fromSettings = "";
  try {
    fromSettings = String(readStore().settings?.openaiProxy || "").trim();
  } catch {
    fromSettings = "";
  }
  return String(
    fromSettings
      || process.env.OPENAI_PROXY
      || process.env.HTTPS_PROXY
      || process.env.https_proxy
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || ""
  ).trim();
}

let proxyAgent;
let proxyAgentUrl = "";

function openaiDispatcher() {
  const url = openaiProxyUrl();
  if (!url) {
    proxyAgent = undefined;
    proxyAgentUrl = "";
    return undefined;
  }
  if (!proxyAgent || proxyAgentUrl !== url) {
    proxyAgent = new ProxyAgent(url);
    proxyAgentUrl = url;
  }
  return proxyAgent;
}

async function openaiHttp(url, options = {}) {
  const dispatcher = openaiDispatcher();
  return undiciFetch(url, dispatcher ? { ...options, dispatcher } : options);
}

async function openaiFetch(url, { method = "GET", headers = {}, body, timeoutMs = 180000, logLabel = "" } = {}) {
  const { apiKey } = openaiConfig();
  if (!apiKey) throw new Error("未配置 OPENAI_API_KEY");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const nextHeaders = {
    Authorization: `Bearer ${apiKey}`,
    ...headers,
  };
  if (body instanceof FormData) {
    delete nextHeaders["Content-Type"];
    delete nextHeaders["content-type"];
  }
  const started = Date.now();
  const requestSnapshot = await snapshotRequestBody(body);
  let response;
  try {
    response = await openaiHttp(url, {
      method,
      headers: nextHeaders,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    await writeOpenAILog({
      label: logLabel,
      requestBody: requestSnapshot,
      error: error.name === "AbortError" ? "OpenAI 请求超时" : error.message,
      elapsedMs: Date.now() - started,
    });
    if (error.name === "AbortError") throw new Error("OpenAI 请求超时");
    const hint = openaiProxyUrl() ? "" : "。直连失败时可在系统设置填写 OpenAI HTTP 代理，例如 http://127.0.0.1:7890";
    throw new Error(`OpenAI 网络请求失败：${error.message}${hint}`);
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    await writeOpenAILog({
      label: logLabel,
      requestBody: requestSnapshot,
      error: `OpenAI 返回不是 JSON：${String(raw).slice(0, 300)}`,
      elapsedMs: Date.now() - started,
    });
    throw new Error(`OpenAI 返回不是 JSON：${raw.slice(0, 300)}`);
  }
  await writeOpenAILog({
    label: logLabel,
    requestBody: requestSnapshot,
    responseBody: data,
    elapsedMs: Date.now() - started,
  });
  if (!response.ok) {
    const message = data.error?.message || data.message || raw.slice(0, 300) || `HTTP ${response.status}`;
    const err = new Error(`OpenAI 请求失败：${message}`);
    err.detail = data;
    throw err;
  }
  return data;
}

export async function optimizeTitleWithApi(originalTitle, site) {
  return generateTitle({ originalTitle, site });
}

function pickImageB64(payload) {
  const item = payload?.data?.[0] || {};
  return item.b64_json || item.b64 || "";
}

function pickImageUrl(payload) {
  const item = payload?.data?.[0] || {};
  return item.url || "";
}

export async function editImageWithReferences({ prompt, files = [], size, logLabel = "" } = {}) {
  const cfg = openaiConfig();
  const text = String(prompt || "").trim();
  if (!text) throw new Error("生图 prompt 为空");
  const refs = (files || []).filter((file) => file && fs.existsSync(file)).slice(0, 16);
  const mappedSize = openaiImageSize(size || cfg.imageSize);
  if (!refs.length) {
    const payload = await openaiFetch(cfg.imageGenerationsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.imageModel,
        prompt: text,
        n: 1,
        size: mappedSize,
      }),
      timeoutMs: 180000,
      logLabel: logLabel || "images-generations",
    });
    return { payload, b64: pickImageB64(payload), url: pickImageUrl(payload) };
  }
  const form = new FormData();
  form.append("model", cfg.imageModel);
  form.append("prompt", text);
  form.append("n", "1");
  form.append("size", mappedSize);
  if (cfg.imageQuality) form.append("quality", cfg.imageQuality);
  if (!/^gpt-image-2/i.test(cfg.imageModel)) form.append("input_fidelity", "high");
  const imageField = refs.length > 1 ? "image[]" : "image";
  for (const file of refs) {
    const buf = fs.readFileSync(file);
    if (buf.length > MAX_REF_IMAGE_BYTES) {
      throw new Error(`参考图过大：${path.basename(file)}`);
    }
    const filename = path.basename(file);
    const mime = mimeFromFile(file);
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    form.append(imageField, new Blob([bytes], { type: mime }), filename);
  }
  const payload = await openaiFetch(cfg.imageEditsUrl, {
    method: "POST",
    body: form,
    timeoutMs: 180000,
    logLabel: logLabel || "images-edits",
  });
  return { payload, b64: pickImageB64(payload), url: pickImageUrl(payload) };
}

export async function saveGeneratedImage(result, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (result?.b64) {
    fs.writeFileSync(dest, Buffer.from(result.b64, "base64"));
    return dest;
  }
  if (result?.url) {
    const response = await openaiHttp(result.url);
    if (!response.ok) throw new Error(`下载生图失败 HTTP ${response.status}`);
    fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
    return dest;
  }
  throw new Error("OpenAI 生图没有返回图片数据");
}
