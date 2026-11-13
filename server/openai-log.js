import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

const usageLogStore = new AsyncLocalStorage();

const logDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "openai-logs");
let seq = 0;

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function nowParts() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    stamp: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

function safeName(label) {
  const text = String(label || "openai").trim() || "openai";
  return text.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "-").slice(0, 80);
}

function dump(value) {
  return JSON.stringify(value, null, 2);
}

function isDataUri(text) {
  return /^data:/i.test(String(text || "").trim());
}

function collectPromptTexts(value, out) {
  if (value == null) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text && !isDataUri(text)) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPromptTexts(item, out);
    return;
  }
  if (typeof value !== "object") return;
  if (typeof value.prompt === "string") collectPromptTexts(value.prompt, out);
  if (value.type === "input_text" || value.type === "text" || value.type === "output_text") {
    collectPromptTexts(value.text, out);
    return;
  }
  if (value.type === "input_image" || value.type === "image_url") return;
  if (value.content != null) collectPromptTexts(value.content, out);
  if (value.input != null) collectPromptTexts(value.input, out);
  if (value.messages != null) collectPromptTexts(value.messages, out);
  if (typeof value.text === "string" && value.format == null) collectPromptTexts(value.text, out);
}

export async function snapshotRequestBody(body) {
  if (body == null) return "";
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const texts = [];
    for (const [name, value] of body.entries()) {
      if (name === "prompt" && typeof value === "string") texts.push(value);
    }
    return texts.join("\n\n");
  }
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return isDataUri(body) ? "" : body;
    }
  }
  if (Buffer.isBuffer(parsed)) return "";
  const texts = [];
  collectPromptTexts(parsed, texts);
  return texts.join("\n\n");
}

export function runWithOpenAIUsageLog(logFn, fn) {
  return usageLogStore.run(logFn, fn);
}

export function isOpenAIUsageLogActive() {
  return typeof usageLogStore.getStore() === "function";
}

function emitOpenAIUsage({ label, usage, elapsedMs }) {
  const usageText = formatOpenAIUsage(usage);
  const line = `OpenAI usage · ${label || "openai"} · ${usageText}${elapsedMs != null ? ` · ${elapsedMs}ms` : ""}`;
  console.log(`[OpenAI usage] ${line}`);
  const sink = usageLogStore.getStore();
  if (typeof sink === "function") {
    sink({
      label: label || "openai",
      usage,
      elapsedMs: elapsedMs ?? null,
      message: line,
    });
  }
}

function numToken(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export const OPENAI_USAGE_FIELDS = [
  ["input_tokens", "总输入 Token"],
  ["output_tokens", "总输出 Token"],
  ["total_tokens", "总 Token"],
  ["input_text_tokens", "输入文本 Token"],
  ["input_image_tokens", "输入图片 Token"],
  ["output_text_tokens", "输出文本 Token"],
  ["output_image_tokens", "输出图片 Token"],
  ["cached_tokens", "缓存输入 Token"],
  ["reasoning_tokens", "推理 Token"],
];

export function emptyOpenAIUsage() {
  const usage = { calls: [] };
  for (const [key] of OPENAI_USAGE_FIELDS) usage[key] = 0;
  return usage;
}

export function extractOpenAIUsage(responseBody) {
  const body = responseBody && typeof responseBody === "object" ? responseBody : {};
  const raw = body.usage || body.response?.usage || {};
  const inDetails = raw.input_tokens_details || raw.prompt_tokens_details || {};
  const outDetails = raw.output_tokens_details || raw.completion_tokens_details || {};
  const input = numToken(raw.input_tokens ?? raw.prompt_tokens ?? raw.inputTokens);
  const output = numToken(raw.output_tokens ?? raw.completion_tokens ?? raw.outputTokens);
  const total = numToken(raw.total_tokens ?? raw.totalTokens ?? (input + output));
  const cached = numToken(inDetails.cached_tokens ?? inDetails.cache_tokens ?? raw.cached_tokens);
  const reasoning = numToken(outDetails.reasoning_tokens ?? raw.reasoning_tokens);
  const hasInputText = inDetails.text_tokens != null || inDetails.textTokens != null;
  const inputImage = numToken(inDetails.image_tokens ?? inDetails.imageTokens);
  let inputText = numToken(inDetails.text_tokens ?? inDetails.textTokens);
  if (!hasInputText) inputText = Math.max(0, input - cached - inputImage);
  const hasOutputImage = outDetails.image_tokens != null || outDetails.imageTokens != null;
  const isImageGen = inDetails.image_tokens != null || inDetails.imageTokens != null;
  let outputImage = numToken(outDetails.image_tokens ?? outDetails.imageTokens);
  let outputText = 0;
  if (hasOutputImage) outputText = Math.max(0, output - outputImage - reasoning);
  else if (isImageGen) {
    outputImage = Math.max(0, output - reasoning);
    outputText = 0;
  } else {
    outputText = Math.max(0, output - reasoning);
    outputImage = 0;
  }
  return {
    ...raw,
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    input_text_tokens: inputText,
    input_image_tokens: inputImage,
    output_text_tokens: outputText,
    output_image_tokens: outputImage,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
    text_tokens: inputText,
    image_tokens: inputImage,
  };
}

export function formatOpenAIUsage(usage) {
  return OPENAI_USAGE_FIELDS.map(([key, label]) => `${label} ${usage?.[key] ?? 0}`).join(" · ");
}

export async function writeOpenAILog({
  label = "",
  requestBody,
  responseBody,
  error,
  elapsedMs,
} = {}) {
  const usage = extractOpenAIUsage(responseBody);
  emitOpenAIUsage({ label, usage, elapsedMs });
  try {
    fs.mkdirSync(logDir, { recursive: true });
    seq += 1;
    const { date, time, stamp } = nowParts();
    const name = `${date}_${time}_${pad(seq, 4)}_${safeName(label)}.log`;
    const prompt = typeof requestBody === "string" ? requestBody : "";
    const payload = {
      time: stamp,
      label: label || "",
      prompt,
    };
    if (error) payload.error = String(error);
    fs.writeFileSync(path.join(logDir, name), dump(payload), "utf8");
  } catch {
    // 写日志失败不影响主流程
  }
}

export function openaiLogDir() {
  return logDir;
}
