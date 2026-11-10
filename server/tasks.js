import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendTaskLog, seedTaskLogs } from "./task-log.js";

function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const tasksPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "tasks.json");
const KEEP = 200;
let cache = null;

function ensureDir() {
  const dir = path.dirname(tasksPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function stripLogs(task) {
  if (!task) return task;
  if (task.logs?.length) seedTaskLogs(task.id, task.logs);
  const { logs, ...rest } = task;
  return rest;
}

function persist(list) {
  cache = (list || []).map(stripLogs).slice(0, KEEP);
  ensureDir();
  fs.writeFileSync(tasksPath, JSON.stringify(cache, null, 2), "utf8");
  return cache;
}

export function readTasks() {
  if (cache) return cache;
  if (!fs.existsSync(tasksPath)) {
    cache = [];
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
    cache = (Array.isArray(raw) ? raw : []).map(stripLogs);
  } catch {
    cache = [];
  }
  return cache;
}

export function writeTasks(mutator) {
  const list = readTasks();
  const next = mutator(list) || list;
  return persist(next);
}

export function getTask(id) {
  return readTasks().find((task) => task.id === id) || null;
}

export function addTask(task) {
  const created = stripLogs(task);
  writeTasks((list) => {
    list.unshift(created);
    return list;
  });
  return created;
}

export function patchTask(id, patch) {
  let found = null;
  writeTasks((list) => {
    const task = list.find((item) => item.id === id);
    if (!task) return list;
    Object.assign(task, typeof patch === "function" ? patch(task) : patch);
    found = task;
    return list;
  });
  return found;
}

export function failTask(id, error) {
  return patchTask(id, { status: "failed", error: String(error?.message || error || "任务失败") });
}

export function ingestStoreTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return;
  const existing = readTasks();
  const ids = new Set(existing.map((task) => task.id));
  const extra = tasks.map(stripLogs).filter((task) => task?.id && !ids.has(task.id));
  if (!existing.length) persist(tasks.map(stripLogs));
  else if (extra.length) persist([...extra, ...existing]);
}

export function failInterruptedTasks() {
  writeTasks((list) => {
    for (const task of list) {
      if (task.status !== "running" && task.status !== "queued") continue;
      task.status = "failed";
      task.error = "服务重启，任务中断";
      appendTaskLog(task.id, { t: now(), level: "error", message: "服务重启，任务中断", extra: "" });
    }
    return list;
  });
}

export function resetTasks() {
  persist([]);
}
