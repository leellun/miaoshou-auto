import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingestStoreTasks, resetTasks } from "./tasks.js";
import { ingestStoreTiktok, persistTiktokItems, readTiktokItems, resetTiktokItems } from "./tiktok-items.js";

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
    openaiProxy: "",
    lastSyncAt: "",
    apiStatus: "",
  },
  shops: [],
  templates: [],
  pricing: [],
  priceTemplateLocals: {},
  shopLocals: {},
  fxRates: {},
  freightTable: {},
  common: [],
  exceptions: [],
  statsToday: { ...emptyStats },
};

function stripFake(data) {
  const fakeTaskIds = new Set(["task-1", "task-2", "task-3"]);
  const fakeCommonIds = new Set(["c-1", "c-2"]);
  const fakeTkIds = new Set(["tk-1", "tk-2"]);
  const fakeExIds = new Set(["ex-1", "ex-2", "ex-3"]);
  if (Array.isArray(data.tasks)) data.tasks = data.tasks.filter((item) => !fakeTaskIds.has(item.id));
  data.common = (data.common || []).filter((item) => {
    if (fakeCommonIds.has(item.id)) return false;
    if (String(item.title || "").startsWith("货源商品 ")) return false;
    return true;
  });
  if (Array.isArray(data.tiktok)) {
    data.tiktok = data.tiktok.filter((item) => {
      if (fakeTkIds.has(item.id)) return false;
      if (String(item.id || "").startsWith("tk-")) return false;
      if (String(item.title || "").startsWith("货源商品 ")) return false;
      return true;
    });
  }
  const fakeShopNames = new Set(["TH Fashion Hub", "MY Trend Store", "MY Home Store", "PH Store 01", "Ozon Global 01"]);
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
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const hadTasks = Array.isArray(raw.tasks);
  const hadTiktok = Object.prototype.hasOwnProperty.call(raw, "tiktok");
  const data = stripFake(raw);
  if (hadTasks) ingestStoreTasks(data.tasks);
  if (hadTiktok) ingestStoreTiktok(Array.isArray(data.tiktok) ? data.tiktok : []);
  delete data.tasks;
  delete data.tiktok;
  data.tiktok = readTiktokItems();
  data.shopLocals = data.shopLocals && typeof data.shopLocals === "object" ? data.shopLocals : {};
  data.shops = (data.shops || []).map((shop) => {
    const local = data.shopLocals[String(shop.id)] || {};
    return { ...shop, pricingId: local.pricingId || "" };
  });
  if (hadTasks || hadTiktok) {
    const { tiktok, tasks, ...rest } = data;
    fs.writeFileSync(storePath, JSON.stringify(rest, null, 2), "utf8");
  }
  return data;
}

function save(data) {
  ensure();
  if (Array.isArray(data.tasks)) ingestStoreTasks(data.tasks);
  if (Array.isArray(data.tiktok)) persistTiktokItems(data.tiktok);
  const { tasks, tiktok, shops, ...rest } = data;
  const nextShops = (shops || []).map((shop) => {
    const { pricingId, ...shopRest } = shop || {};
    return shopRest;
  });
  fs.writeFileSync(storePath, JSON.stringify({ ...rest, shops: nextShops }, null, 2), "utf8");
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
  resetTasks();
  resetTiktokItems();
  save({ ...seed, tiktok: [] });
  return { ...seed, tiktok: [] };
}

export { now };
