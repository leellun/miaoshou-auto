import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  try {
    fs.mkdirSync(logDir, { recursive: true });
    seq += 1;
    const { date, time, stamp } = nowParts();
    const name = `${date}_${time}_${pad(seq, 4)}_${safeName(label)}.log`;
    const payload = {
      time: stamp,
      label: label || "",
      elapsed_ms: elapsedMs ?? null,
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
