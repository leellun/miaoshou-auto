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

function parseMaybeJson(text) {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function serializeFormData(form) {
  const fields = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      fields.push({ name, value });
      continue;
    }
    const buf = Buffer.from(await value.arrayBuffer());
    fields.push({
      name,
      filename: value.name || "blob",
      type: value.type || "",
      size: buf.length,
      base64: buf.toString("base64"),
    });
  }
  return { type: "multipart/form-data", fields };
}

async function serializeBody(body) {
  if (body == null) return null;
  if (typeof body === "string") return parseMaybeJson(body);
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return serializeFormData(body);
  }
  if (Buffer.isBuffer(body)) return { type: "buffer", base64: body.toString("base64") };
  return body;
}

export async function snapshotRequestBody(body) {
  return serializeBody(body);
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

export function extractOpenAIUsage(responseBody) {
  const body = responseBody && typeof responseBody === "object" ? responseBody : {};
  const raw = body.usage || body.response?.usage || {};
  const input = Number(raw.input_tokens ?? raw.prompt_tokens ?? raw.inputTokens ?? 0);
  const output = Number(raw.output_tokens ?? raw.completion_tokens ?? raw.outputTokens ?? 0);
  const total = Number(raw.total_tokens ?? raw.totalTokens ?? (input + output));
  return {
    ...raw,
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    total_tokens: Number.isFinite(total) ? total : 0,
  };
}

export function formatOpenAIUsage(usage) {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const total = usage?.total_tokens ?? 0;
  return `input_tokens ${input} · output_tokens ${output} · total_tokens ${total}`;
}

export async function writeOpenAILog({
  label = "",
  method,
  url,
  headers,
  requestBody,
  status,
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
    const payload = {
      time: stamp,
      label: label || "",
      elapsed_ms: elapsedMs ?? null,
      usage,
      request: {
        method: String(method || "POST").toUpperCase(),
        url,
        headers: headers || null,
        body: requestBody ?? null,
      },
      response: {
        status: status ?? null,
        error: error ? String(error) : null,
        body: responseBody ?? null,
      },
    };
    fs.writeFileSync(path.join(logDir, name), dump(payload), "utf8");
  } catch {
    // 写日志失败不影响主流程
  }
}

export function openaiLogDir() {
  return logDir;
}
