import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const logDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "task-logs");
const cache = new Map();

function ensureDir() {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}

function logPath(taskId) {
  const id = String(taskId || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
  return path.join(logDir, `${id}.jsonl`);
}

export function readTaskLogs(taskId) {
  const id = String(taskId || "");
  if (!id) return [];
  if (cache.has(id)) return cache.get(id);
  const file = logPath(id);
  if (!fs.existsSync(file)) {
    cache.set(id, []);
    return [];
  }
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { t: "", level: "info", message: line, extra: "" };
    }
  });
  cache.set(id, rows);
  return rows;
}

export function appendTaskLog(taskId, line) {
  if (!taskId) return;
  const id = String(taskId);
  const rows = readTaskLogs(id);
  rows.push(line);
  cache.set(id, rows);
  ensureDir();
  fs.appendFileSync(logPath(id), `${JSON.stringify(line)}\n`, "utf8");
}

export function seedTaskLogs(taskId, lines) {
  if (!taskId || !Array.isArray(lines) || !lines.length) return;
  const id = String(taskId);
  if (readTaskLogs(id).length) return;
  ensureDir();
  fs.writeFileSync(logPath(id), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  cache.set(id, [...lines]);
}

export function withTaskLogs(task) {
  if (!task) return task;
  const { logs: _ignored, ...rest } = task;
  return { ...rest, logs: readTaskLogs(task.id) };
}
