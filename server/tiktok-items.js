import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tiktokPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "tiktok.json");
let cache = null;

function ensureDir() {
  const dir = path.dirname(tiktokPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function persist(items) {
  cache = Array.isArray(items) ? items : [];
  ensureDir();
  fs.writeFileSync(tiktokPath, JSON.stringify(cache, null, 2), "utf8");
  return cache;
}

export function readTiktokItems() {
  if (cache) return cache;
  if (!fs.existsSync(tiktokPath)) {
    cache = [];
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(tiktokPath, "utf8"));
    cache = Array.isArray(raw) ? raw : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function persistTiktokItems(items) {
  return persist(items);
}

export function ingestStoreTiktok(items) {
  if (!Array.isArray(items) || !items.length) return;
  if (!readTiktokItems().length) persist(items);
}

export function resetTiktokItems() {
  persist([]);
}
