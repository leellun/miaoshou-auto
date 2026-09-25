import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const storePath = path.join(dataDir, "store.json");

function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const emptyStats = {
  collected: 0,
  processed: 0,
  published: 0,
  exceptions: 0,
  pipeline: [0, 0, 0, 0, 0, 0],
  collectDelta: 0,
};

const seed = {
  settings: {
    mode: "live",
    baseUrl: "https://openapi-erp.91miaoshou.com",
    appId: "",
    appSecret: "",
    signStyle: "header",
    minMargin: 15,
    skipOnError: true,
    lastSyncAt: "",
    apiStatus: "",
  },
  shops: [],
  templates: [],
  pricing: [],
  tasks: [],
  common: [],
  tiktok: [],
  exceptions: [],
  statsToday: { ...emptyStats },
};

function stripFake(data) {
  const fakeTaskIds = new Set(["task-1", "task-2", "task-3"]);
  const fakeCommonIds = new Set(["c-1", "c-2"]);
  const fakeTkIds = new Set(["tk-1", "tk-2"]);
  const fakeExIds = new Set(["ex-1", "ex-2", "ex-3"]);
  data.tasks = (data.tasks || []).filter((item) => !fakeTaskIds.has(item.id));
  data.common = (data.common || []).filter((item) => {
    if (fakeCommonIds.has(item.id)) return false;
    if (String(item.title || "").startsWith("货源商品 ")) return false;
    return true;
  });
  data.tiktok = (data.tiktok || []).filter((item) => {
    if (fakeTkIds.has(item.id)) return false;
    if (String(item.id || "").startsWith("tk-")) return false;
    if (String(item.title || "").startsWith("货源商品 ")) return false;
    return true;
  });
  const fakeShopNames = new Set(["Bangkok Essentials", "TH Fashion Hub", "MY Trend Store", "MY Home Store", "PH Store 01", "Ozon Global 01"]);
  data.shops = (data.shops || []).filter((item) => !fakeShopNames.has(item.name));
  data.exceptions = (data.exceptions || []).filter((item) => !fakeExIds.has(item.id));
  if (data.statsToday?.collected === 286 || data.statsToday?.collectDelta === 18.4) {
    data.statsToday = { ...emptyStats };
  }
  return data;
}

function ensure() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify(seed, null, 2), "utf8");
  }
}

function load() {
  ensure();
  const data = JSON.parse(fs.readFileSync(storePath, "utf8"));
  return stripFake(data);
}

function save(data) {
  ensure();
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), "utf8");
}

export function readStore() {
  return load();
}

export function writeStore(mutator) {
  const data = load();
  const next = mutator(data) || data;
  save(next);
  return next;
}

export function resetStore() {
  save(seed);
  return seed;
}

export { now };
