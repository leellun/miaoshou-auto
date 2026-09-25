import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { ENDPOINTS, applyShopsToTiktokItems, batchDeleteCommonCollectBox, batchDeleteTiktokCollectBox, claimTiktokToShop, getCachedShopList, getCommonCollectBoxList, getPriceTemplateList, mapCommonCollectItems, mapPriceTemplates, mapTiktokCollectItems, peekShopListCache, resolveSettings, searchTiktokCollectList } from "./miaoshou.js";
import { appendLog, createClaimTask, createOptimizeTask, createTask, failInterruptedTasks, publishProducts, runClaimTask, runOptimizeTask, runTask } from "./pipeline.js";
import { now, readStore, resetStore, writeStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function publicSettings(settings) {
  const resolved = resolveSettings(settings);
  return {
    mode: resolved.mode,
    baseUrl: resolved.baseUrl,
    appId: resolved.appId,
    appSecretMasked: resolved.appSecret ? `${resolved.appSecret.slice(0, 4)}****` : "",
    hasSecret: Boolean(resolved.appSecret),
    minMargin: settings.minMargin,
    skipOnError: settings.skipOnError,
    lastSyncAt: settings.lastSyncAt,
    apiStatus: resolved.mode === "live" ? settings.apiStatus : "",
    lastError: settings.lastError || "",
  };
}

app.get("/api/health", (_req, res) => {
  const store = readStore();
  res.json({
    ok: true,
    apiStatus: store.settings.mode === "live" ? store.settings.apiStatus : "",
    lastSyncAt: store.settings.lastSyncAt,
  });
});

app.get("/api/overview", (_req, res) => {
  const store = readStore();
  res.json({
    stats: store.statsToday,
    tasks: store.tasks.slice(0, 8),
    exceptions: store.exceptions.slice(0, 8),
    settings: publicSettings(store.settings),
    defaultTemplate: store.templates.find((t) => t.enabled) || store.templates[0],
  });
});

function filterShops(items, { platform, site, q = "" }) {
  const keyword = String(q).toLowerCase();
  return items.filter((shop) => {
    if (platform && String(shop.platform).toLowerCase() !== String(platform).toLowerCase()) return false;
    if (site && shop.site && String(shop.site).toUpperCase() !== String(site).toUpperCase()) return false;
    if (keyword && !`${shop.name} ${shop.id}`.toLowerCase().includes(keyword)) return false;
    return true;
  });
}

app.get("/api/shops", async (req, res) => {
  const { platform = "", site = "", q = "" } = req.query;
  const store = readStore();
  const settings = resolveSettings(store.settings);
  if (settings.mode === "live") {
    if (!platform) {
      return res.json({ items: filterShops(store.shops, { platform, site, q }), endpoint: ENDPOINTS.shopList, live: false });
    }
    try {
      const mapped = await getCachedShopList(settings, { platform, site: platform.toLowerCase() === "tiktok" ? "" : site });
      writeStore((s) => {
        if (mapped.length) {
          const rest = platform ? s.shops.filter((x) => x.platform !== platform) : [];
          s.shops = [...mapped, ...rest];
        }
        s.settings.apiStatus = "ok";
        s.settings.lastSyncAt = now();
        s.settings.lastError = "";
        return s;
      });
      return res.json({ items: filterShops(mapped.length ? mapped : readStore().shops, { platform, site, q }), endpoint: ENDPOINTS.shopList, live: true });
    } catch (error) {
      writeStore((s) => {
        s.settings.apiStatus = "error";
        s.settings.lastError = error.message;
        return s;
      });
      const cached = filterShops(store.shops, { platform, site, q });
      if (cached.length) {
        return res.json({ items: cached, endpoint: ENDPOINTS.shopList, live: false, stale: true, error: error.message });
      }
      return res.status(502).json({ error: error.message, detail: error.detail || null, endpoint: ENDPOINTS.shopList });
    }
  }
  res.json({ items: filterShops(store.shops, { platform, site, q }), endpoint: ENDPOINTS.shopList, live: false });
});

app.post("/api/shops/sync", async (req, res) => {
  const store = readStore();
  const settings = resolveSettings(store.settings);
  if (settings.mode === "live") {
    try {
      const mapped = await getCachedShopList(settings, { platform: req.body?.platform || "tiktok", site: req.body?.site || "", force: true });
      writeStore((s) => {
        if (mapped.length) s.shops = mapped;
        s.settings.apiStatus = "ok";
        s.settings.lastSyncAt = now();
        s.settings.lastError = "";
        return s;
      });
    } catch (error) {
      return res.status(502).json({ error: error.message, detail: error.detail || null });
    }
  } else {
    writeStore((s) => {
      s.settings.lastSyncAt = now();
      s.settings.apiStatus = "";
      return s;
    });
  }
  res.json({ items: readStore().shops });
});

app.get("/api/common", async (req, res) => {
  const { tab = "all", q = "" } = req.query;
  const store = readStore();
  const settings = resolveSettings(store.settings);
  const tabMap = { unclaimed: "noClaimed", claimed: "claimed", failed: "collectFail", all: "all" };
  const keyword = String(q).trim();
  let liveError = "";
  if (settings.mode === "live") {
    try {
      const remote = await getCommonCollectBoxList(settings, {
        pageNo: 1,
        pageSize: 20,
        tabPaneName: tabMap[tab] || "all",
        sourceItemIdKeyword: keyword,
      });
      const mapped = mapCommonCollectItems(remote.response, { status: tabMap[tab] || "" });
      writeStore((s) => {
        s.common = mapped;
        return s;
      });
    } catch (error) {
      liveError = error.message;
    }
  }
  const latest = readStore();
  const items = latest.common.filter((item) => {
    if (tab === "unclaimed" && item.status !== "unclaimed") return false;
    if (tab === "claimed" && item.status !== "claimed") return false;
    if (tab === "failed" && item.status !== "failed") return false;
    if (keyword && ![item.title, item.boxId, item.sourceId].join(" ").toLowerCase().includes(keyword.toLowerCase())) return false;
    return true;
  });
  const counts = {
    all: latest.common.length,
    unclaimed: latest.common.filter((x) => x.status === "unclaimed").length,
    claimed: latest.common.filter((x) => x.status === "claimed").length,
    failed: latest.common.filter((x) => x.status === "failed").length,
  };
  res.json({ items, counts, liveError, endpoint: ENDPOINTS.commonList });
});

app.post("/api/common/delete", async (req, res) => {
  const ids = req.body.ids || [];
  const store = readStore();
  const settings = resolveSettings(store.settings);
  const requested = ids.map(String);
  const selected = store.common.filter((item) => requested.includes(String(item.id)) || requested.includes(String(item.detailId)) || requested.includes(String(item.boxId)));
  const drop = new Set(selected.map((item) => String(item.id)));
  const detailIds = [...new Set([
    ...selected.map((item) => item.detailId || item.boxId || item.id),
    ...ids,
  ].map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  try {
    if (settings.mode === "live") {
      if (!detailIds.length) return res.status(400).json({ error: "没有可删除的公共采集箱 ID" });
      await batchDeleteCommonCollectBox(settings, detailIds);
    }
    writeStore((s) => {
      s.common = s.common.filter((item) => !drop.has(String(item.id)) && !requested.includes(String(item.id)));
      return s;
    });
    res.json({ ok: true, deleted: detailIds.length || selected.length });
  } catch (error) {
    res.status(502).json({ error: error.message, detail: error.detail || null, endpoint: ENDPOINTS.commonBatchDelete });
  }
});

app.post("/api/common/claim", (req, res) => {
  try {
    const { ids = [], shopIds = [], shops = [], pricingId, autoPublish, aiTitle, schedule } = req.body;
    const task = createClaimTask({ ids, shopIds, shops, pricingId, autoPublish, aiTitle, schedule });
    setTimeout(() => runClaimTask(task.id).catch((error) => {
      appendLog(task.id, "error", `任务异常退出：${error.message}`, error.detail || "");
      writeStore((store) => {
        const current = store.tasks.find((t) => t.id === task.id);
        if (current) {
          current.status = "failed";
          current.error = error.message;
        }
        return store;
      });
    }), 30);
    res.json(task);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/tiktok", async (req, res) => {
  const { tab = "all", site = "", q = "" } = req.query;
  const store = readStore();
  const settings = resolveSettings(store.settings);
  const statusMap = { unpublished: "notPublished", scheduled: "timingPublish", published: "published" };
  const keyword = String(q).trim();
  let liveError = "";
  let tiktokShops = peekShopListCache("tiktok", "") || [];
  if (settings.mode === "live" && tab !== "ai") {
    try {
      if (!tiktokShops.length) {
        tiktokShops = await getCachedShopList(settings, { platform: "tiktok", site: "" });
        if (tiktokShops.length) {
          writeStore((s) => {
            const rest = s.shops.filter((x) => x.platform !== "tiktok");
            s.shops = [...tiktokShops, ...rest];
            return s;
          });
        }
      }
      const remote = await searchTiktokCollectList(settings, {
        pageNo: 1,
        pageSize: 20,
        status: statusMap[tab] || "",
        sourceItemIdKeyword: keyword,
      });
      const mapped = applyShopsToTiktokItems(mapTiktokCollectItems(remote, { status: statusMap[tab] || "" }), tiktokShops);
      writeStore((s) => {
        s.tiktok = mapped;
        return s;
      });
    } catch (error) {
      liveError = error.message;
    }
  }
  const latest = readStore();
  const items = latest.tiktok.filter((item) => {
    if (site && item.site && item.site !== site) return false;
    if (tab === "unpublished" && item.publishStatus !== "unpublished") return false;
    if (tab === "scheduled" && item.publishStatus !== "scheduled") return false;
    if (tab === "published" && item.publishStatus !== "published") return false;
    if (tab === "ai" && item.publishStatus !== "ai") return false;
    if (keyword && ![item.title, item.sourceId, item.detailId].join(" ").toLowerCase().includes(keyword.toLowerCase())) return false;
    return true;
  });
  const counts = {
    all: latest.tiktok.length,
    unpublished: latest.tiktok.filter((x) => x.publishStatus === "unpublished").length,
    scheduled: latest.tiktok.filter((x) => x.publishStatus === "scheduled").length,
    published: latest.tiktok.filter((x) => x.publishStatus === "published").length,
    ai: latest.tiktok.filter((x) => x.publishStatus === "ai").length,
  };
  res.json({ items, counts, liveError, endpoint: ENDPOINTS.tiktokList });
});

app.post("/api/tiktok/assign-shop", async (req, res) => {
  const { ids = [], shopId, shopIds = [], shops = [] } = req.body;
  const store = readStore();
  const settings = resolveSettings(store.settings);
  const idList = (shopIds.length ? shopIds : shopId ? [shopId] : shops.map((s) => s.id)).map(String).filter(Boolean);
  const picked = idList.map((id) => shops.find((s) => String(s.id) === String(id)) || store.shops.find((s) => String(s.id) === String(id))).filter((shop) => shop && String(shop.platform || "tiktok").toLowerCase() === "tiktok");
  const requested = ids.map(String);
  const selected = store.tiktok.filter((item) => requested.includes(String(item.id)) || requested.includes(String(item.detailId)) || requested.includes(String(item.collectBoxDetailId)));
  const detailIds = [...new Set([
    ...selected.map((item) => item.collectBoxDetailId || item.detailId || item.id),
    ...ids,
  ].map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  try {
    if (!picked.length) return res.status(400).json({ error: "请先选择 TikTok 店铺" });
    if (settings.mode === "live") {
      if (!detailIds.length) return res.status(400).json({ error: "没有可认领的 TK 采集箱 ID" });
      for (const detailId of detailIds) {
        for (const shop of picked) {
          await claimTiktokToShop(settings, {
            detailIds: [Number(detailId)],
            shopIds: [Number(shop.id)],
          });
        }
      }
    }
    writeStore((s) => {
      const shopsNow = s.shops;
      const resolved = idList.map((id) => picked.find((shop) => String(shop.id) === String(id)) || shopsNow.find((shop) => String(shop.id) === String(id))).filter(Boolean);
      if (!resolved.length) return s;
      for (const id of requested) {
        const item = s.tiktok.find((x) => String(x.id) === String(id) || String(x.detailId) === String(id) || String(x.collectBoxDetailId) === String(id));
        if (!item) continue;
        item.shopId = resolved[0].id;
        item.shopIds = resolved.map((shop) => String(shop.id));
        item.shopName = resolved.map((shop) => shop.name).join(" / ");
        item.site = resolved[0].site || item.site;
        item.issues = (item.issues || []).filter((x) => x !== "缺少店铺");
        if (!item.issues.length) item.checkStatus = "pass";
      }
      return s;
    });
    res.json({ ok: true, claimed: detailIds.length * picked.length });
  } catch (error) {
    res.status(502).json({ error: error.message, detail: error.detail || null, endpoint: ENDPOINTS.tiktokClaimToShop });
  }
});

app.post("/api/tiktok/delete", async (req, res) => {
  const ids = req.body.ids || [];
  const store = readStore();
  const settings = resolveSettings(store.settings);
  const requested = ids.map(String);
  const selected = store.tiktok.filter((item) => requested.includes(String(item.id)) || requested.includes(String(item.detailId)) || requested.includes(String(item.collectBoxDetailId)));
  const drop = new Set(selected.map((item) => String(item.id)));
  const detailIds = [...new Set([
    ...selected.map((item) => item.collectBoxDetailId || item.detailId || item.id),
    ...ids,
  ].map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  try {
    if (settings.mode === "live") {
      if (!detailIds.length) return res.status(400).json({ error: "没有可删除的 TK 采集箱 ID" });
      await batchDeleteTiktokCollectBox(settings, detailIds);
    }
    writeStore((s) => {
      s.tiktok = s.tiktok.filter((item) => !drop.has(String(item.id)) && !requested.includes(String(item.id)));
      return s;
    });
    res.json({ ok: true, deleted: detailIds.length || selected.length });
  } catch (error) {
    res.status(502).json({ error: error.message, detail: error.detail || null, endpoint: ENDPOINTS.tiktokBatchDelete });
  }
});

app.post("/api/tiktok/optimize", (req, res) => {
  try {
    const task = createOptimizeTask(req.body.ids || []);
    setTimeout(() => runOptimizeTask(task.id).catch((error) => {
      appendLog(task.id, "error", `任务异常退出：${error.message}`, error.detail || "");
      writeStore((store) => {
        const current = store.tasks.find((t) => t.id === task.id);
        if (current) {
          current.status = "failed";
          current.error = error.message;
        }
        return store;
      });
    }), 30);
    res.json(task);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/tiktok/publish", (req, res) => {
  const published = publishProducts(req.body.ids || []);
  res.json({ ok: true, published });
});

app.get("/api/templates", (_req, res) => res.json({ items: readStore().templates }));
app.post("/api/templates", (req, res) => {
  writeStore((store) => {
    const item = { id: `tpl-${Date.now()}`, enabled: true, aiTitle: true, autoCategory: true, imageClean: true, autoPublish: true, profit: 25, ...req.body };
    store.templates.unshift(item);
    return store;
  });
  res.json({ ok: true, items: readStore().templates });
});

const priceTemplateCache = new Map();

app.get("/api/price-templates", async (req, res) => {
  const { name = "", site = "", siteType = "" } = req.query;
  const store = readStore();
  const settings = resolveSettings(store.settings);
  if (settings.mode === "live") {
    const cacheKey = `${name}|${site}|${siteType}`;
    const hit = priceTemplateCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 15000) {
      return res.json({ items: hit.items, live: true, cached: true, endpoint: ENDPOINTS.priceTemplateList });
    }
    try {
      const remote = await getPriceTemplateList(settings, {
        name,
        site,
        siteType,
        pageNo: 1,
        pageSize: 20,
      });
      const items = mapPriceTemplates(remote);
      priceTemplateCache.set(cacheKey, { at: Date.now(), items });
      return res.json({ items, live: true, endpoint: ENDPOINTS.priceTemplateList });
    } catch (error) {
      if (hit) return res.json({ items: hit.items, live: true, stale: true, endpoint: ENDPOINTS.priceTemplateList });
      return res.status(502).json({ error: error.message, detail: error.detail || null, endpoint: ENDPOINTS.priceTemplateList });
    }
  }
  const fallback = (store.pricing || []).map((item) => ({
    id: item.id,
    name: item.name,
    site: site || "TH",
    siteType: siteType || "mainland",
    siteTypeLabel: "本土",
  }));
  res.json({ items: fallback, live: false, endpoint: ENDPOINTS.priceTemplateList });
});

app.get("/api/pricing", (_req, res) => res.json({ items: readStore().pricing }));
app.post("/api/pricing", (req, res) => {
  writeStore((store) => {
    store.pricing.unshift({ id: `price-${Date.now()}`, profit: 20, fx: { THB: 4.9, MYR: 0.61, PHP: 8.1 }, minMargin: 15, ...req.body });
    return store;
  });
  res.json({ ok: true, items: readStore().pricing });
});

app.get("/api/settings", (_req, res) => res.json(publicSettings(readStore().settings)));
app.post("/api/settings", (req, res) => {
  writeStore((store) => {
    const next = { ...store.settings, ...req.body };
    if (!req.body.appSecret) next.appSecret = store.settings.appSecret;
    store.settings = next;
    return store;
  });
  res.json(publicSettings(readStore().settings));
});

app.get("/api/tasks/:id", (req, res) => {
  const task = readStore().tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  res.json(task);
});

app.post("/api/tasks", (req, res) => {
  try {
    const task = createTask(req.body);
    setTimeout(() => runTask(task.id).catch((error) => {
      appendLog(task.id, "error", `任务异常退出：${error.message}`, error.detail || "");
      writeStore((store) => {
        const current = store.tasks.find((t) => t.id === task.id);
        if (current) {
          current.status = "failed";
          current.error = error.message;
        }
        return store;
      });
    }), 30);
    res.json(task);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/dev/reset", (_req, res) => res.json(resetStore()));

const webDist = path.join(__dirname, "..", "web", "dist");
app.use(express.static(webDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) next();
  });
});

failInterruptedTasks();

app.listen(PORT, () => {
  console.log(`妙手自动上架服务已启动 http://localhost:${PORT}`);
});
