import { extractSourceId, parseLinks, sourceFromUrl } from "./catalog.js";
import { claimTiktokToShop, claimToPlatform, fetchItem, getCachedShopList, getCommonCollectBoxList, getCommonDetail, getTiktokShopDetail, getTiktokSiteDetail, mapCommonRow, mapTiktokCollectItems, peekShopListCache, pickCommonCollectBoxDetailId, pickSourceDetailMap, resolveDetailIdFromMap, resolveSettings, saveTiktokShopDetail, saveTiktokSiteDetail, searchTiktokCollectList } from "./miaoshou.js";
import { hasOpenAIConfig, optimizeTitleWithApi } from "./openai-api.js";
import { emptyOpenAIUsage, isOpenAIUsageLogActive, OPENAI_USAGE_FIELDS, runWithOpenAIUsageLog } from "./openai-log.js";
import { runOpenAIDetailFlow } from "./detail-flow.js";
import { runProductImageFlow } from "./product-image-flow.js";
import { applyOptimizedTitle, pickOriginalTitle } from "./product-title.js";
import { applyDefaultWeight, applyDetailHeader, applyImgUrls, applyPackageDimensions, applyPriceTemplateId, applySaveFieldDefaults, applySkuImageUrlMap, assembleInterleavedNotes, collectMainImageUrls, collectSkuImageUrls, downloadDetailImages, downloadImagesByUrls, removeDir } from "./detail-images.js";
import { ossConfigured, uploadGeneratedImages } from "./oss.js";
import { now, readStore, writeStore } from "./store.js";
import { applySkuPricesFromTemplate, mergePriceTemplate, priceKindOfShop } from "./tiktok-th-price.js";
import { normalizeFxRates } from "./fx-rates.js";
import { normalizeFreightTable } from "./freight-table.js";
import { addTask, getTask, patchTask } from "./tasks.js";
import { appendTaskLog } from "./task-log.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STEP_LABELS = [
  "正在提交妙手采集",
  "已取得公共采集箱 ID",
  "正在认领到目标平台",
  "获取详情",
  "AI 优化标题",
  "生成详情文案",
  "保存采集信息",
];

const OPTIMIZE_STEP_LABELS = [
  "获取详情",
  "AI 优化标题",
  "生成详情文案",
  "保存采集信息",
];

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveShopCollectToTxt({ detailId, shopId, shopCollectItemInfo }) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "shop-collect-saves");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now().replace(/[: ]/g, "-");
  const file = path.resolve(dir, `${stamp}_detail-${detailId}_shop-${shopId}_${Date.now()}.txt`);
  const text = JSON.stringify({
    detailId: Number(detailId),
    shopId: Number(shopId),
    shopCollectItemInfo,
  }, null, 2);
  fs.writeFileSync(file, text, "utf8");
  return file;
}

function pickOssMd5(payload) {
  if (!payload || typeof payload !== "object") return "";
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
  return data.ossMd5 || data.oss_md5 || "";
}

function pickShopCollectItemInfo(payload) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
  return data.shopCollectItemInfo || data.siteCollectItemInfo || data.shop_collect_item_info || data.site_collect_item_info || data;
}

function hasCategoryCid(info) {
  const cid = info?.cid ?? info?.categoryId ?? info?.productCid ?? info?.category_id;
  if (cid == null) return false;
  const text = String(cid).trim();
  return text !== "" && text !== "0";
}

function pickRandomSite(shops, fallback = "TH") {
  const sites = [...new Set((shops || []).map((shop) => String(shop?.site || "").trim()).filter(Boolean))];
  if (!sites.length) return fallback || "TH";
  return sites[Math.floor(Math.random() * sites.length)];
}

function setTaskSteps(taskId, labels, currentIndex, progress) {
  patchTask(taskId, (current) => ({
    steps: labels.map((label, idx) => ({
      label,
      state: idx < currentIndex ? "done" : idx === currentIndex ? "current" : "wait",
    })),
    progress: progress ?? Math.round(((currentIndex + 0.35) / labels.length) * 100),
  }));
}

function shopIdsFromItem(item) {
  const fromList = Array.isArray(item?.collectBoxDetailShopList)
    ? item.collectBoxDetailShopList.map((shop) => String(shop?.shopId || "")).filter(Boolean)
    : [];
  if (fromList.length) return [...new Set(fromList)];
  const fromIds = Array.isArray(item?.shopIds) ? item.shopIds.map((id) => String(id || "")).filter(Boolean) : [];
  if (fromIds.length) return [...new Set(fromIds)];
  return item?.shopId ? [String(item.shopId)] : [];
}

function shopsFromIds(ids, cachedShops, fallbackSite = "") {
  const byId = new Map((cachedShops || []).map((shop) => [String(shop.id), shop]));
  return ids.map((id) => {
    const hit = byId.get(String(id));
    return {
      id: String(id),
      name: hit?.name || String(id),
      platform: "tiktok",
      platformName: hit?.platformName || "TikTok",
      site: hit?.site || fallbackSite || "TH",
      type: hit?.type || "",
      isCb: hit?.isCb,
      isCnsc: hit?.isCnsc,
    };
  });
}

async function claimTiktokCollectToOneShop(settings, { tkDetailId, shop, taskId, sourceId }) {
  if (!tkDetailId || !shop?.id) return;
  if (String(shop.platform || "tiktok").toLowerCase() !== "tiktok") return;
  const body = { detailIds: [Number(tkDetailId)], shopIds: [Number(shop.id)] };
  if (taskId) {
    appendLog(taskId, "info", `claim_to_shop 一对一 · ${shop.name} · ${shop.id}`, {
      path: "/open/v1/product/collect_box/tiktok/collect_box/claim_to_shop",
      body,
    });
  }
  const result = await claimTiktokToShop(settings, body);
  if (taskId) appendLog(taskId, "info", `claim_to_shop 返回 · ${shop.name}`, result);
  return result;
}

function withTaskOpenAIUsage(taskId, fn) {
  if (!taskId || isOpenAIUsageLogActive()) return fn();
  return runWithOpenAIUsageLog((entry) => {
    const usage = entry?.usage || {};
    const label = entry?.label || "openai";
    const nums = {};
    for (const [key] of OPENAI_USAGE_FIELDS) nums[key] = Number(usage[key] || 0);
    appendLog(taskId, "info", `OpenAI usage · ${label} · ${OPENAI_USAGE_FIELDS.map(([key, name]) => `${name} ${nums[key]}`).join(" · ")}`);
    patchTask(taskId, (task) => {
      const prev = task.openaiUsage || emptyOpenAIUsage();
      const next = emptyOpenAIUsage();
      for (const [key] of OPENAI_USAGE_FIELDS) next[key] = Number(prev[key] || 0) + nums[key];
      next.calls = [...(prev.calls || []), {
        t: now(),
        label,
        ...nums,
        elapsedMs: entry?.elapsedMs ?? null,
      }].slice(-80);
      return { openaiUsage: next };
    });
  }, fn);
}

async function fillTiktokShopAfterClaim(opts) {
  if (opts.taskId && !isOpenAIUsageLogActive()) {
    return withTaskOpenAIUsage(opts.taskId, () => fillTiktokShopAfterClaim(opts));
  }
  const { settings, detailId, shops, taskId, sourceId, aiTitle, onPhase, fetchBySite = false, site = "", waitBeforeGetMs = 0 } = opts;
  if (!hasOpenAIConfig()) throw new Error("未配置 OPENAI_API_KEY");
  const storeShops = readStore().shops || [];
  const storeShopById = new Map(storeShops.map((item) => [String(item.id), item]));
  const tiktokShops = (shops || []).filter((shop) => {
    if (!shop?.id) return false;
    return String(shop.platform || "tiktok").toLowerCase() === "tiktok";
  }).map((shop) => {
    const fromStore = storeShopById.get(String(shop.id)) || {};
    return {
      ...shop,
      type: shop.type || fromStore.type || "",
      isCb: shop.isCb ?? fromStore.isCb,
      isCnsc: shop.isCnsc ?? fromStore.isCnsc,
      pricingId: shop.pricingId || fromStore.pricingId || "",
    };
  });
  const siteCode = String(site || pickRandomSite(tiktokShops) || "TH").toUpperCase();
  if (!tiktokShops.length && !fetchBySite) {
    if (taskId) appendLog(taskId, "warn", `${sourceId || ""} 没有店铺 ID，跳过 get/save`.trim());
    return;
  }
  const shopsToSave = tiktokShops.length
    ? tiktokShops
    : [{ id: "", name: `站点 ${siteCode}`, site: siteCode, platform: "tiktok" }];
  if (waitBeforeGetMs > 0) {
    await waitWithLogs(taskId, waitBeforeGetMs, "店铺认领后等待 5–10 秒再获取详情");
  }
  let sharedInfo = null;
  if (fetchBySite) {
    onPhase?.(0);
    if (taskId) {
      appendLog(taskId, "info", `列表没有店铺 ID，改用 get_site_collect_item_info · ${siteCode}`, {
        path: "/open/v1/product/collect_box/tiktok/collect_box/get_site_collect_item_info",
        body: { detailId: Number(detailId), site: siteCode },
      });
    }
    sharedInfo = await getTiktokSiteDetail(settings, detailId, siteCode);
    if (taskId) appendLog(taskId, "info", `get_site_collect_item_info 返回 · ${siteCode}`, sharedInfo);
  }
  const processShops = fetchBySite ? [shopsToSave[0]] : shopsToSave;
  for (let index = 0; index < processShops.length; index += 1) {
    const shop = processShops[index];
    try {
      if (taskId) appendLog(taskId, "info", `处理店铺 ${index + 1}/${shopsToSave.length} · ${shop.name} · ${shop.id || siteCode}`);
      onPhase?.(0);
      let info = sharedInfo;
      if (!info) {
        if (taskId) {
          appendLog(taskId, "info", `调用 get_shop_collect_item_info · ${shop.name}`, {
            path: "/open/v1/product/collect_box/tiktok/collect_box/get_shop_collect_item_info",
            body: { detailId: Number(detailId), shopId: Number(shop.id) },
          });
        }
        info = await getTiktokShopDetail(settings, detailId, shop.id);
        if (taskId) appendLog(taskId, "info", `get_shop_collect_item_info 返回 · ${shop.name}`, info);
      }
      let shopCollectItemInfo = pickShopCollectItemInfo(info);
      if (!shopCollectItemInfo) {
        if (taskId) appendLog(taskId, "warn", `店铺采集信息为空，跳过保存 · ${shop.name}`);
        continue;
      }
      if (!hasCategoryCid(shopCollectItemInfo)) {
        if (taskId) {
          appendLog(taskId, "error", `详情 cid 分类没有值，终止后续处理 · ${shop.name}`, {
            cid: shopCollectItemInfo.cid ?? "",
          });
        }
        throw new Error("详情 cid 分类没有值，已终止后续处理");
      }
      onPhase?.(1);
      if (aiTitle !== false) {
        const originalTitle = pickOriginalTitle(shopCollectItemInfo);
        if (originalTitle) {
          try {
            if (taskId) appendLog(taskId, "info", `调用 OpenAI pipeline.title 优化标题 · ${shop.site || "TH"}`, originalTitle);
            const optimized = await optimizeTitleWithApi(originalTitle, shop.site || "TH");
            shopCollectItemInfo = applyOptimizedTitle(shopCollectItemInfo, optimized);
            if (taskId) appendLog(taskId, "info", `标题已优化：${originalTitle} → ${optimized}`);
          } catch (error) {
            if (taskId) appendLog(taskId, "error", `标题优化失败，已终止：${error.message}`, error.detail || "");
            throw error;
          }
        } else if (taskId) {
          appendLog(taskId, "warn", `详情里没有标题字段，跳过标题优化 · ${shop.name}`);
        }
      }
      onPhase?.(2);
      let imageDir = "";
      let generatedDir = "";
      try {
        const downloaded = await downloadDetailImages(shopCollectItemInfo);
        imageDir = downloaded.dir;
        if (taskId) appendLog(taskId, "info", `详情图已下载 ${downloaded.files.length}/${downloaded.urls.length} 张到 ${downloaded.dir}`);
        if (downloaded.files.length) {
          if (taskId) appendLog(taskId, "info", `详情：extract-plan → 拼图 → 分析生图 · 原图 ${downloaded.files.length} 张`);
          const flow = await runOpenAIDetailFlow({
            files: downloaded.files,
            urls: downloaded.urls,
            site: shop.site || "TH",
            productId: String(detailId),
            onLog: (message, extra) => appendLog(taskId, "info", message, extra),
          });
          if (taskId) appendLog(taskId, "info", `详情套图已生成 ${flow.files.length} 张`);
          generatedDir = flow.dir;
          if (!ossConfigured()) {
            if (taskId) appendLog(taskId, "warn", "未配置 OSS，本次不替换详情图地址");
          } else {
            if (taskId) appendLog(taskId, "info", "开始上传详情图到阿里云 OSS");
            const imageUrls = await uploadGeneratedImages(flow.files, { detailId, shopId: shop.id });
            if (taskId) {
              for (const url of imageUrls) appendLog(taskId, "info", `OSS 图片 ${url}`);
            }
            const blocks = imageUrls.map((url, index) => ({
              url,
              text: flow.pages?.[index]?.productDetails || "",
            }));
            shopCollectItemInfo = applyDetailHeader(shopCollectItemInfo, assembleInterleavedNotes(blocks));
          }
        } else if (taskId) {
          appendLog(taskId, "warn", `没有可用详情图，跳过详情套图 · ${shop.name}`);
        }
      } catch (error) {
        if (taskId) appendLog(taskId, "error", `详情套图生成失败，已终止：${error.message}`, error.detail || "");
        throw error;
      } finally {
        removeDir(imageDir);
        removeDir(generatedDir);
      }
      let mainDir = "";
      let mainGeneratedDir = "";
      try {
        const mainUrls = collectMainImageUrls(shopCollectItemInfo);
        if (!mainUrls.length) {
          if (taskId) appendLog(taskId, "info", "imgUrls 为空，跳过商品图转化");
        } else {
          const downloadedMain = await downloadImagesByUrls(mainUrls, { prefix: "miaoshou-main-", unique: false });
          mainDir = downloadedMain.dir;
          if (taskId) appendLog(taskId, "info", `商品图已下载 ${downloadedMain.files.length}/${mainUrls.length} 张到 ${downloadedMain.dir}`);
          if (!downloadedMain.files.length) {
            if (taskId) appendLog(taskId, "warn", "商品图下载失败，跳过转化");
          } else {
            let generatedMain;
            if (taskId) appendLog(taskId, "info", `主图：analyze → image2 · ${downloadedMain.files.length} 张（第一张白底无字）`);
            generatedMain = await runProductImageFlow({
              files: downloadedMain.files,
              urls: downloadedMain.urls,
              site: shop.site || "TH",
              imageKind: "main",
              onLog: (message, extra) => appendLog(taskId, "info", message, extra),
            });
            mainGeneratedDir = generatedMain.dir;
            if (taskId) appendLog(taskId, "info", `商品新图已生成 ${generatedMain.files.length} 张到 ${generatedMain.dir}`, generatedMain.log?.slice(0, 400));
            if (!ossConfigured()) {
              if (taskId) appendLog(taskId, "warn", "未配置 OSS，本次不替换 imgUrls");
            } else {
              const mainOssUrls = await uploadGeneratedImages(generatedMain.files, { detailId, shopId: shop.id, kind: "main" });
              shopCollectItemInfo = applyImgUrls(shopCollectItemInfo, mainOssUrls);
              if (taskId) {
                appendLog(taskId, "info", `已替换 imgUrls ${mainOssUrls.length} 张`);
                for (const url of mainOssUrls) appendLog(taskId, "info", `商品图 OSS ${url}`);
              }
            }
          }
        }
      } catch (error) {
        if (taskId) appendLog(taskId, "error", `商品图转化失败，已终止：${error.message}`, error.detail || "");
        throw error;
      } finally {
        removeDir(mainDir);
        removeDir(mainGeneratedDir);
      }
      let skuDir = "";
      let skuGeneratedDir = "";
      try {
        const skuUrls = collectSkuImageUrls(shopCollectItemInfo);
        if (!skuUrls.length) {
          if (taskId) appendLog(taskId, "info", "没有 SKU 图，跳过 SKU 转化");
        } else {
          const downloadedSku = await downloadImagesByUrls(skuUrls, { prefix: "miaoshou-sku-" });
          skuDir = downloadedSku.dir;
          if (taskId) appendLog(taskId, "info", `SKU 图已下载 ${downloadedSku.files.length}/${skuUrls.length} 张到 ${downloadedSku.dir}`);
          if (!downloadedSku.files.length) {
            if (taskId) appendLog(taskId, "warn", "SKU 图下载失败，跳过转化");
          } else {
            let generatedSku;
            if (taskId) appendLog(taskId, "info", `SKU：analyze → image2 · ${downloadedSku.files.length} 张`);
            generatedSku = await runProductImageFlow({
              files: downloadedSku.files,
              urls: downloadedSku.urls,
              site: shop.site || "TH",
              imageKind: "sku",
              onLog: (message, extra) => appendLog(taskId, "info", message, extra),
            });
            skuGeneratedDir = generatedSku.dir;
            if (taskId) appendLog(taskId, "info", `SKU 新图已生成 ${generatedSku.files.length} 张到 ${generatedSku.dir}`, generatedSku.log?.slice(0, 400));
            if (!ossConfigured()) {
              if (taskId) appendLog(taskId, "warn", "未配置 OSS，本次不替换 SKU 图地址");
            } else {
              const skuOssUrls = await uploadGeneratedImages(generatedSku.files, { detailId, shopId: shop.id, kind: "sku" });
              const urlMap = new Map();
              const count = Math.min(downloadedSku.urls.length, skuOssUrls.length);
              for (let i = 0; i < count; i += 1) urlMap.set(downloadedSku.urls[i], skuOssUrls[i]);
              shopCollectItemInfo = applySkuImageUrlMap(shopCollectItemInfo, urlMap);
              if (taskId) {
                appendLog(taskId, "info", `已替换 ${urlMap.size} 张 SKU 图地址`);
                for (const url of skuOssUrls) appendLog(taskId, "info", `SKU OSS ${url}`);
              }
            }
          }
        }
      } catch (error) {
        if (taskId) appendLog(taskId, "error", `SKU 图转化失败，已终止：${error.message}`, error.detail || "");
        throw error;
      } finally {
        removeDir(skuDir);
        removeDir(skuGeneratedDir);
      }
      onPhase?.(3);
      shopCollectItemInfo = applyPackageDimensions(shopCollectItemInfo);
      shopCollectItemInfo = applyDefaultWeight(shopCollectItemInfo);
      shopCollectItemInfo = applySaveFieldDefaults(shopCollectItemInfo);
      if (taskId) {
        appendLog(taskId, "info", `包裹尺寸 ${shopCollectItemInfo.packageLength}×${shopCollectItemInfo.packageWidth}×${shopCollectItemInfo.packageHeight} cm · 包裹重量 ${shopCollectItemInfo.weight}`);
      }
      const ossMd5 = pickOssMd5(info);
      const targets = fetchBySite ? shopsToSave : [shop];
      const storeForPrice = readStore();
      const freightTable = normalizeFreightTable(storeForPrice.freightTable);
      const fxRates = normalizeFxRates(storeForPrice.fxRates);
      for (const target of targets) {
        const templateId = String(target.pricingId || shop.pricingId || "").trim();
        if (!templateId) throw new Error(`${target.name || shop.name} 没有绑定定价模板，无法计算售价`);
        let toSave = applyPriceTemplateId(structuredClone(shopCollectItemInfo), templateId);
        const tpl = resolveLocalPriceTemplate(templateId);
        const kind = priceKindOfShop(target) || priceKindOfShop(shop) || (tpl.siteType === "cross_border" ? "cross_border" : "mainland");
        const priced = applySkuPricesFromTemplate(toSave, tpl, {
          kind,
          freightTable,
          fxRates,
          site: target.site || shop.site || siteCode,
        });
        toSave = priced.info;
        if (taskId) {
          appendLog(taskId, "info", `${target.name || shop.name} ${kind === "cross_border" ? "跨境" : "本土"} · 本地定价模板 ${tpl.name || templateId}`);
          for (const row of priced.rows) {
            const bump = row.raised ? `，不足 35 已改为 35 ${row.currency}` : "";
            appendLog(taskId, "info", `SKU ${row.key} 成本 originPrice ${row.cost} CNY · 计费重 ${row.wReal} → ${row.field} ${row.sitePrice} ${row.currency}（折前 ${row.price} CNY / 折后 ${row.after} CNY）${bump}`);
          }
        }
        const savedPath = saveShopCollectToTxt({
          detailId,
          shopId: target.id || siteCode,
          shopCollectItemInfo: toSave,
        });
        if (taskId) appendLog(taskId, "info", `详情已保存到本地文件 ${savedPath}`);
        console.log(toSave)
        if (target.id) {
          if (taskId) {
            appendLog(taskId, "info", `调用 save_shop_collect_item_info · ${target.name}`, {
              path: "/open/v1/product/collect_box/tiktok/collect_box/save_shop_collect_item_info",
              body: { detailId: Number(detailId), shopId: Number(target.id) },
            });
          }
          const saved = await saveTiktokShopDetail(settings, {
            detailId,
            shopId: target.id,
            shopCollectItemInfo: toSave,
            ossMd5,
          });
          if (taskId) appendLog(taskId, "info", `save_shop_collect_item_info 返回 · ${target.name}`, saved);
        } else {
          if (taskId) {
            appendLog(taskId, "info", `调用 save_site_collect_item_info · ${siteCode}`, {
              path: "/open/v1/product/collect_box/tiktok/collect_box/save_site_collect_item_info",
              body: { detailId: Number(detailId), site: siteCode },
            });
          }
          const saved = await saveTiktokSiteDetail(settings, {
            detailId,
            site: siteCode,
            shopCollectItemInfo: toSave,
            ossMd5,
          });
          if (taskId) appendLog(taskId, "info", `save_site_collect_item_info 返回 · ${siteCode}`, saved);
        }
      }
    } catch (error) {
      if (taskId) appendLog(taskId, "error", `店铺采集信息处理失败 ${shop.name}：${error.message}`, error.detail || "");
      throw error;
    }
  }
}

function saveCommonDetailId(itemId, detailId) {
  writeStore((store) => {
    const current = store.common.find((x) => x.id === itemId);
    if (current) {
      current.detailId = String(detailId);
      current.boxId = String(detailId);
    }
    return store;
  });
}

async function lookupCollectSuccessDetailId(settings, sourceId, taskId, excludeIds = []) {
  const tabs = ["collectSuccess", "noClaimed", "all"];
  for (const tabPaneName of tabs) {
    const body = {
      pageNo: 1,
      pageSize: 20,
      filter: {
        tabPaneName,
        sourceItemIdKeyword: String(sourceId || ""),
      },
    };
    if (taskId) {
      appendLog(taskId, "info", `调用 get_common_collect_box_list · 货源 ${sourceId} · ${tabPaneName}`, {
        path: "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list",
        body,
      });
    }
    const result = await getCommonCollectBoxList(settings, {
      pageNo: 1,
      pageSize: 20,
      tabPaneName,
      sourceItemIdKeyword: sourceId,
    });
    if (taskId) appendLog(taskId, "info", `get_common_collect_box_list 返回 · 货源 ${sourceId} · ${tabPaneName}`, result.response);
    const detailId = pickCommonCollectBoxDetailId(result.response, sourceId, excludeIds);
    if (detailId) {
      if (taskId) appendLog(taskId, "info", `列表回查得到可认领公共采集箱 ${detailId} · 货源 ${sourceId}`);
      return detailId;
    }
  }
  if (taskId) appendLog(taskId, "warn", `列表未找到可认领记录 · 货源 ${sourceId}（skip/已采集过的不算）`);
  return "";
}

async function claimOneTarget(snapshot, settings, { detailId, target, sourceId, taskId, excludeIds = [], serialNumber = 1 }) {
  const claimBody = {
    detailSerialNumberPlatformList: [
      { detailId: Number(detailId), platform: target.platform, serialNumber },
    ],
  };
  try {
    if (taskId) {
      appendLog(taskId, "info", `调用 claimed · ${target.name} · serialNumber ${serialNumber}`, {
        path: "/open/v1/product/common_collect_box/common_collect_box/claimed",
        body: claimBody,
      });
    }
    const claimed = await liveOrNull(snapshot, (cfg) => claimToPlatform(cfg, detailId, target.platform, serialNumber));
    if (taskId) appendLog(taskId, "info", `claimed 返回 · ${sourceId} → ${target.name}`, claimed?.response ?? claimed);
    return String(detailId);
  } catch (error) {
    if (taskId) appendLog(taskId, "error", `认领失败 ${sourceId} → ${target.name}：${error.message}`, error.detail || "");
    const listedId = await lookupCollectSuccessDetailId(settings, sourceId, taskId, [String(detailId), ...excludeIds]);
    if (!listedId || listedId === String(detailId)) {
      if (taskId) appendLog(taskId, "warn", `${sourceId} 没有其他可认领采集箱。当前 ID 多半是 skip/已采集过，不能再认领`);
      return "";
    }
    if (taskId) appendLog(taskId, "info", `用列表回查的采集箱 ID 重试认领 · ${listedId} → ${target.name}`);
    const retry = await liveOrNull(snapshot, (cfg) => claimToPlatform(cfg, listedId, target.platform, serialNumber));
    if (taskId) appendLog(taskId, "info", `claimed 重试返回 · ${sourceId} → ${target.name}`, retry?.response ?? retry);
    return String(listedId);
  }
}

async function lookupTiktokCollectDetail(settings, { sourceId, commonDetailId, taskId, excludeIds = [] }) {
  const statuses = ["notPublished", ""];
  const excluded = new Set((excludeIds || []).map((id) => String(id)));
  for (const status of statuses) {
    const response = await searchTiktokCollectList(settings, {
      pageNo: 1,
      pageSize: 20,
      status,
      sourceItemIdKeyword: sourceId || "",
    });
    if (taskId) {
      appendLog(taskId, "info", `search_collect_box_detail_list 返回 · 货源 ${sourceId || commonDetailId || ""} · ${status || "全部"}`, response);
    }
    const items = mapTiktokCollectItems(response, { status }).filter((item) => item?.id && !excluded.has(String(item.id)));
    const commonId = String(commonDetailId || "");
    const wantSource = String(sourceId || "");
    const hit = items.find((row) => commonId && String(row.commonCollectBoxDetailId) === commonId)
      || items.find((row) => wantSource && String(row.sourceId) === wantSource)
      || (items.length === 1 ? items[0] : items[0] || null);
    if (hit?.id) return hit;
  }
  return null;
}

async function lookupTiktokCollectDetailWithRetry(settings, { sourceId, commonDetailId, taskId, excludeIds = [], attempts = 4, gapMs = 8000 }) {
  for (let i = 0; i < attempts; i += 1) {
    if (i) await waitWithLogs(taskId, gapMs, `第 ${i + 1} 次回查 TK 采集箱`);
    else if (taskId) appendLog(taskId, "info", `回查 TK 采集箱 · 货源 ${sourceId || ""} · 公共采集箱 ${commonDetailId || ""}`);
    const hit = await lookupTiktokCollectDetail(settings, { sourceId, commonDetailId, taskId, excludeIds });
    if (hit?.id) {
      if (taskId) appendLog(taskId, "info", `已取得 TK 采集箱 ${hit.id} · 货源 ${sourceId || hit.sourceId || ""}`);
      return hit;
    }
  }
  if (taskId) appendLog(taskId, "warn", `未找到 TK 采集箱 · 货源 ${sourceId || ""} · 公共采集箱 ${commonDetailId || ""}`);
  return null;
}

function resolveTaskShops(task, store) {
  const ids = [...new Set((task?.shopIds || []).map((id) => String(id || "")).filter(Boolean))];
  const snapshots = Array.isArray(task?.shopSnapshots) ? task.shopSnapshots : [];
  const byId = new Map();
  for (const shop of store?.shops || []) byId.set(String(shop.id), shop);
  for (const shop of snapshots) {
    if (shop?.id) byId.set(String(shop.id), { ...byId.get(String(shop.id)), ...shop });
  }
  if (!ids.length) return [...byId.values()].filter((shop) => snapshots.some((s) => String(s.id) === String(shop.id)));
  return shopsFromIds(ids, [...byId.values()], snapshots[0]?.site || "");
}

function upsertTiktokItem(item) {
  if (!item?.id) return;
  writeStore((store) => {
    const index = store.tiktok.findIndex((row) => String(row.id) === String(item.id));
    if (index >= 0) store.tiktok[index] = { ...store.tiktok[index], ...item };
    else store.tiktok.unshift(item);
    return store;
  });
}

async function waitWithLogs(taskId, ms, reason) {
  const started = Date.now();
  appendLog(taskId, "info", `开始等待 ${Math.round(ms / 1000)} 秒：${reason}`);
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(10000, remaining);
    await sleep(chunk);
    remaining = ms - (Date.now() - started);
    if (remaining > 500) {
      appendLog(taskId, "info", `仍在等待采集箱落库，剩余约 ${Math.ceil(remaining / 1000)} 秒`);
    }
  }
  appendLog(taskId, "info", `等待结束，实际过去 ${Date.now() - started} 毫秒`);
}

function resolveLocalPriceTemplate(pricingId) {
  const id = String(pricingId || "").trim();
  if (!id) throw new Error("没有定价模板，无法计算售价");
  const local = readStore().priceTemplateLocals?.[id];
  if (!local || typeof local !== "object" || !Object.keys(local).length) {
    throw new Error(`店铺绑定的定价模板 ${id} 还没有本地保存，请先在定价模板里打开并保存`);
  }
  return mergePriceTemplate({ id, ...local }, local);
}

function getTemplate(store, templateId) {
  return store.templates.find((x) => x.id === templateId) || store.templates[0];
}

export { failInterruptedTasks } from "./tasks.js";

export function appendLog(taskId, level, message, extra) {
  const line = {
    t: now(),
    level,
    message,
    extra: extra == null ? "" : typeof extra === "string" ? extra.slice(0, 1200) : JSON.stringify(extra).slice(0, 1200),
  };
  console.log(`[采集] ${level} ${message}${line.extra ? ` ${line.extra}` : ""}`);
  appendTaskLog(taskId, line);
}

export function createTask({ linksText, shopIds, shops: shopList = [], templateId, autoPublish, aiTitle, autoCategory, claimPerPlatform, schedule }) {
  const links = parseLinks(linksText);
  if (!links.length) throw new Error("请至少填写一个货源链接");
  const selectedIds = [...new Set((shopIds || []).map((id) => String(id || "")).filter(Boolean))];

  const store = readStore();
  const fromStore = store.shops.filter((s) => selectedIds.includes(String(s.id)));
  const snapshots = (shopList || [])
    .filter((shop) => shop?.id)
    .map((shop) => ({
      id: String(shop.id),
      name: shop.name || String(shop.id),
      platform: shop.platform || "tiktok",
      platformName: shop.platformName || "TikTok",
      site: shop.site || "TH",
      type: shop.type || "",
      isCb: shop.isCb,
      isCnsc: shop.isCnsc,
      pricingId: shop.pricingId || "",
    }));
  const shops = snapshots.length ? snapshots : fromStore;
  const template = getTemplate(store, templateId);
  return addTask({
    id: uid("task"),
    kind: "collect",
    title: `链接采集批次 · ${links.length} 个链接`,
    emoji: "＋",
    meta: `${shops.map((s) => `${s.platformName || s.platform} ${s.site}`).join(" / ") || "未选店铺"} · ${schedule === "manual" ? "手动发布" : schedule === "tonight" ? "定时发布" : autoPublish ? "自动发布" : "仅采集"}`,
    status: "queued",
    progress: 0,
    ok: 0,
    fail: 0,
    createdAt: now(),
    links,
    shopIds: selectedIds.length ? selectedIds : shops.map((s) => String(s.id)),
    shopSnapshots: shops,
    templateId: template?.id,
    autoPublish: autoPublish === true,
    aiTitle: aiTitle !== false,
    autoCategory: autoCategory !== false,
    claimPerPlatform: claimPerPlatform !== false,
    schedule: schedule || (autoPublish ? "now" : "manual"),
    steps: STEP_LABELS.map((label) => ({ label, state: "wait" })),
    openaiUsage: emptyOpenAIUsage(),
  });
}

export function createOptimizeTask(ids = []) {
  const itemIds = [...new Set((ids || []).map((id) => String(id || "")).filter(Boolean))];
  if (!itemIds.length) throw new Error("请选择要优化的商品");
  const store = readStore();
  const items = store.tiktok.filter((item) => itemIds.includes(String(item.id)));
  return addTask({
    id: uid("task"),
    kind: "optimize",
    engine: "openai",
    title: `AI 优化 · ${items.length || itemIds.length} 个商品`,
    emoji: "⌁",
    meta: "OpenAI 标题 + 详情图",
    status: "queued",
    progress: 0,
    ok: 0,
    fail: 0,
    createdAt: now(),
    itemIds,
    aiTitle: true,
    steps: OPTIMIZE_STEP_LABELS.map((label) => ({ label, state: "wait" })),
    openaiUsage: emptyOpenAIUsage(),
  });
}

export async function runOptimizeTask(taskId) {
  if (!isOpenAIUsageLogActive()) return withTaskOpenAIUsage(taskId, () => runOptimizeTask(taskId));
  const started = Date.now();
  patchTask(taskId, { status: "running", progress: 4 });
  const snapshot = readStore();
  const task = getTask(taskId);
  if (!task) return;
  const settings = resolveSettings(snapshot.settings);
  const live = settings.mode === "live" && settings.appId && settings.appSecret;
  if (!live) {
    appendLog(taskId, "error", "未配置正式模式或 App Key / App Secret，已跳过优化");
    patchTask(taskId, { status: "failed", progress: 100, error: "未接妙手接口", durationMs: Date.now() - started });
    return;
  }
  appendLog(taskId, "info", `AI 优化开始 · ${task.itemIds.length} 个商品 · OpenAI`);
  if (!hasOpenAIConfig()) {
    appendLog(taskId, "error", "未配置 OPENAI_API_KEY，已跳过优化");
    patchTask(taskId, { status: "failed", progress: 100, error: "未配置 OPENAI_API_KEY", durationMs: Date.now() - started });
    return;
  }
  setTaskSteps(taskId, OPTIMIZE_STEP_LABELS, 0);
  let cachedShops = peekShopListCache("tiktok", "") || [];
  if (!cachedShops.length) {
    try {
      cachedShops = await getCachedShopList(settings, { platform: "tiktok", site: "" });
    } catch (error) {
      appendLog(taskId, "warn", `店铺列表缓存为空且刷新失败：${error.message}`, error.detail || "");
    }
  }
  let ok = 0;
  let fail = 0;
  for (const itemId of task.itemIds) {
    const latest = readStore();
    const item = latest.tiktok.find((row) => String(row.id) === String(itemId));
    if (!item) {
      fail += 1;
      appendLog(taskId, "warn", `列表里没有商品 ${itemId}，跳过`);
      continue;
    }
    const detailId = item.collectBoxDetailId || item.detailId || item.id;
    const shopIds = shopIdsFromItem(item);
    appendLog(taskId, "info", `${item.title || detailId} · collectBoxDetailShopList 店铺 ${shopIds.join("、") || "无"}`);
    if (!detailId) {
      fail += 1;
      appendLog(taskId, "error", `${item.title || itemId} 没有采集箱 ID`);
      continue;
    }
    const fetchBySite = !shopIds.length;
    const shops = fetchBySite
      ? []
      : shopsFromIds(shopIds, cachedShops, item.site);
    const site = fetchBySite ? pickRandomSite(cachedShops, item.site || "TH") : (item.site || pickRandomSite(shops));
    if (fetchBySite) {
      appendLog(taskId, "info", `${item.title || detailId} 列表没有店铺 ID，用站点 ${site} 获取详情`);
    }
    try {
        await fillTiktokShopAfterClaim({
        settings,
        detailId,
        shops,
        taskId,
        sourceId: item.sourceId,
        aiTitle: task.aiTitle !== false,
        fetchBySite,
        site,
        onPhase: (phase) => setTaskSteps(taskId, OPTIMIZE_STEP_LABELS, phase),
      });
      ok += 1;
      writeStore((store) => {
        const current = store.tiktok.find((row) => String(row.id) === String(itemId));
        if (current) current.publishStatus = current.publishStatus === "published" ? current.publishStatus : "unpublished";
        return store;
      });
    } catch (error) {
      fail += 1;
      appendLog(taskId, "error", `${item.title || detailId} 优化失败：${error.message}`, error.detail || "");
    }
  }
  patchTask(taskId, (current) => ({
    status: fail && !ok ? "failed" : "success",
    progress: 100,
    ok,
    fail,
    error: fail && !ok ? current.error || "优化失败" : "",
    steps: OPTIMIZE_STEP_LABELS.map((label) => ({ label, state: "done" })),
    durationMs: Date.now() - started,
  }));
  appendLog(taskId, fail && !ok ? "error" : "info", `任务结束 · 成功 ${ok} · 异常 ${fail}`);
}

async function liveOrNull(store, runner) {
  const settings = resolveSettings(store.settings);
  if (settings.mode !== "live") return null;
  try {
    return await runner(settings);
  } catch (error) {
    writeStore((s) => {
      s.settings.apiStatus = "error";
      s.settings.lastError = error.message;
      return s;
    });
    throw error;
  }
}

async function claimAndFillCommonItems({ snapshot, settings, task, shops, items, taskId }) {
  let ok = 0;
  let fail = 0;
  if (!shops.length) {
    appendLog(taskId, "warn", "未选择平台店铺，跳过认领");
  }
  for (const item of items) {
    setTaskSteps(taskId, STEP_LABELS, 2);
    let detailId = item.detailId || item.boxId;
    if (!detailId) {
      appendLog(taskId, "warn", `${item.sourceId || item.id} 没有采集箱 ID，先按货源回查采集成功列表`);
      try {
        detailId = await lookupCollectSuccessDetailId(settings, item.sourceId, taskId);
        if (detailId) saveCommonDetailId(item.id, detailId);
      } catch (error) {
        appendLog(taskId, "error", `回查采集箱列表失败 ${item.sourceId || item.id}：${error.message}`, error.detail || "");
      }
    }
    if (!detailId) {
      fail += 1;
      appendLog(taskId, "warn", `${item.sourceId || item.id} 没有采集箱 ID，跳过认领`);
      continue;
    }
    appendLog(taskId, "info", `开始认领 · 公共采集箱 ${detailId} · ${shops.length} 个店铺 · 每店一次 claimed，TikTok 立刻 claim_to_shop 一对一`);
    const serialByPlatform = {};
    const usedTkIds = [];
    const tiktokJobs = [];
    let claimedOk = false;
    for (const shop of shops) {
      const platform = String(shop.platform || "tiktok").toLowerCase();
      const target = { platform, name: `${shop.platformName || platform} · ${shop.name}` };
      serialByPlatform[platform] = (serialByPlatform[platform] || 0) + 1;
      const serialNumber = serialByPlatform[platform];
      const claimedId = await claimOneTarget(snapshot, settings, {
        detailId,
        target,
        sourceId: item.sourceId,
        taskId,
        serialNumber,
      });
      if (!claimedId) continue;
      claimedOk = true;
      if (platform !== "tiktok") continue;
      await waitWithLogs(taskId, 10000, `给 ${shop.name} 的 TK 采集箱落库`);
      const tkItem = await lookupTiktokCollectDetailWithRetry(settings, {
        sourceId: item.sourceId,
        commonDetailId: detailId,
        taskId,
        excludeIds: usedTkIds,
      });
      if (!tkItem?.id) {
        appendLog(taskId, "warn", `${shop.name} 平台认领成功但未找到 TK 采集箱，跳过 claim_to_shop`);
        continue;
      }
      usedTkIds.push(String(tkItem.id));
      try {
        await claimTiktokCollectToOneShop(settings, {
          tkDetailId: tkItem.id,
          shop,
          taskId,
          sourceId: item.sourceId,
        });
        tiktokJobs.push({ shop, tkItem });
      } catch (error) {
        appendLog(taskId, "error", `${shop.name} claim_to_shop 失败：${error.message}`, error.detail || "");
      }
    }
    if (!shops.length) continue;
    if (!claimedOk) {
      fail += 1;
      appendLog(taskId, "warn", `${item.sourceId || item.id} 认领未成功，跳过拉取详情`);
      continue;
    }
    writeStore((store) => {
      const current = store.common.find((x) => x.id === item.id || String(x.detailId) === String(detailId));
      if (current) {
        current.claimed = true;
        current.status = "claimed";
      }
      return store;
    });
    try {
      const detail = await getCommonDetail(settings, detailId);
      const row = detail && typeof detail === "object" && detail.data && typeof detail.data === "object" ? detail.data : detail;
      if (row && typeof row === "object") {
        const mapped = mapCommonRow(row);
        writeStore((store) => {
          const current = store.common.find((x) => x.id === item.id || String(x.detailId) === String(detailId));
          if (!current) return store;
          Object.assign(current, mapped, {
            id: current.id,
            url: current.url || mapped.url,
            sourceId: current.sourceId || mapped.sourceId,
            claimed: true,
            status: "claimed",
          });
          return store;
        });
      }
    } catch (error) {
      appendLog(taskId, "warn", `拉取公共采集箱详情失败：${error.message}`, error.detail || "");
    }
    setTaskSteps(taskId, STEP_LABELS, 3);
    if (!tiktokJobs.length) {
      const hasTiktok = shops.some((shop) => String(shop.platform || "tiktok").toLowerCase() === "tiktok");
      if (!hasTiktok) {
        appendLog(taskId, "info", `${item.sourceId || item.id} 未选 TikTok 店铺，跳过 TK 详情加工`);
        ok += 1;
        continue;
      }
      fail += 1;
      appendLog(taskId, "error", `${item.sourceId || item.id} 没有完成 TikTok claim_to_shop，跳过详情加工`);
      continue;
    }
    let tiktokOk = 0;
    for (const job of tiktokJobs) {
      upsertTiktokItem({
        ...job.tkItem,
        sourceId: job.tkItem.sourceId || item.sourceId,
        publishStatus: "unpublished",
      });
      const fetchBySite = !shopIdsFromItem(job.tkItem).length;
      const site = job.shop.site || pickRandomSite([job.shop], job.tkItem.site || "TH");
      try {
        await fillTiktokShopAfterClaim({
          settings,
          detailId: job.tkItem.id,
          shops: [job.shop],
          taskId,
          sourceId: item.sourceId,
          aiTitle: task.aiTitle,
          fetchBySite,
          site,
          waitBeforeGetMs: 5000 + Math.floor(Math.random() * 5001),
          onPhase: (phase) => setTaskSteps(taskId, STEP_LABELS, Math.min(3 + phase, STEP_LABELS.length - 1)),
        });
        tiktokOk += 1;
      } catch (error) {
        appendLog(taskId, "error", `${item.sourceId || item.id} → ${job.shop.name} 详情加工失败：${error.message}`, error.detail || "");
      }
    }
    if (tiktokOk) {
      ok += 1;
      if (task.schedule === "now" || task.autoPublish) {
        appendLog(taskId, "info", "采集加工已保存，发布接口未对接，商品留在 TK 采集箱未发布");
      }
    } else {
      fail += 1;
    }
  }
  return { ok, fail };
}

export async function runTask(taskId) {
  if (!isOpenAIUsageLogActive()) return withTaskOpenAIUsage(taskId, () => runTask(taskId));
  const started = Date.now();
  patchTask(taskId, { status: "running", progress: 4 });

  const snapshot = readStore();
  const task = getTask(taskId);
  if (!task) return;

  const shops = resolveTaskShops(task, snapshot);
  const settings = resolveSettings(snapshot.settings);
  const live = settings.mode === "live" && settings.appId && settings.appSecret;
  let fetchMap = {};
  let liveError = "";

  appendLog(taskId, "info", `任务开始 · ${task.links.length} 个链接 · ${live ? "正式模式" : "未接妙手接口"} · 店铺 ${shops.map((s) => `${s.name}(${s.id})`).join("、") || "未选"}`);
  if (live) {
    setTaskSteps(taskId, STEP_LABELS, 0);
    try {
      appendLog(taskId, "info", "调用妙手 fetch_item", { collectLinks: task.links });
      const payload = await liveOrNull(snapshot, (cfg) => fetchItem(cfg, task.links));
      fetchMap = pickSourceDetailMap(payload);
      const pairs = Object.entries(fetchMap);
      appendLog(taskId, pairs.length ? "info" : "warn", pairs.length ? `fetch_item 货源ID与公共采集箱ID映射 · ${pairs.length} 条` : "fetch_item 没有返回 sourceItemIdAndDetailIdMap", payload);
      for (const [sourceId, detailId] of pairs) {
        appendLog(taskId, "info", `货源 ${sourceId} → 公共采集箱 ${detailId}`);
      }
      setTaskSteps(taskId, STEP_LABELS, 1);
      await waitWithLogs(taskId, 30000, "给采集箱落库后再认领");
    } catch (error) {
      liveError = error.message;
      appendLog(taskId, "error", `fetch_item 失败：${error.message}`, error.detail || "");
    }
  } else {
    liveError = "未配置正式模式或 App Key / App Secret，已跳过采集";
    appendLog(taskId, "error", liveError);
  }

  let ok = 0;
  let fail = 0;
  const createdCommon = [];
  const pendingLogs = [];

  writeStore((store) => {
    for (const url of task.links) {
      const sourceId = extractSourceId(url);
      const detailId = resolveDetailIdFromMap(fetchMap, sourceId, url);
      const exists = store.common.find((item) => item.sourceId === sourceId || (detailId && String(item.detailId) === String(detailId)));
      const commonItem = exists || {
        id: detailId || uid("c"),
        boxId: detailId ? String(detailId) : "",
        detailId: detailId ? String(detailId) : "",
        sourceId,
        source: sourceFromUrl(url),
        title: "",
        thumbnail: "",
        cover: "",
        itemNum: "",
        group: "",
        priceMin: "",
        priceMax: "",
        currency: "",
        stock: "",
        weight: "",
        claimed: false,
        status: "unclaimed",
        createdAt: now(),
        url,
      };
      if (detailId) {
        commonItem.id = String(detailId);
        commonItem.boxId = String(detailId);
        commonItem.detailId = String(detailId);
        pendingLogs.push(["info", `链接已取得采集箱 ID ${detailId}`, sourceId]);
      } else {
        pendingLogs.push(["warn", "链接未返回采集箱 ID", url]);
      }
      if (!exists) store.common.unshift(commonItem);
      createdCommon.push(commonItem);
    }
    store.statsToday.collected = store.common.length;
    store.statsToday.processed = store.tiktok.length;
    store.statsToday.published = store.tiktok.filter((x) => x.publishStatus === "published").length;
    store.statsToday.exceptions = store.exceptions.length;
    store.statsToday.pipeline = [
      store.statsToday.collected,
      store.statsToday.collected,
      store.statsToday.processed,
      store.statsToday.processed,
      store.statsToday.published,
      store.statsToday.published,
    ];
    store.settings.lastSyncAt = now();
    return store;
  });

  for (const row of pendingLogs) appendLog(taskId, row[0], row[1], row[2]);

  if (live) {
    const claimed = await claimAndFillCommonItems({ snapshot, settings, task, shops, items: createdCommon, taskId });
    ok = claimed.ok;
    fail = claimed.fail;
  }

  appendLog(taskId, liveError ? "error" : "info", liveError ? `任务结束，采集接口出错：${liveError}` : `任务结束 · 成功 ${ok} · 异常 ${fail}`);
  patchTask(taskId, (current) => ({
    status: liveError || (fail && !ok) || fail ? "failed" : "success",
    progress: 100,
    ok,
    fail,
    error: liveError || current.error || "",
    steps: current.steps.map((step) => ({ ...step, state: "done" })),
    durationMs: Date.now() - started,
    result: { common: createdCommon.length, liveError },
  }));
}

export function createClaimTask({ ids = [], shopIds = [], shops: shopList = [], autoPublish, aiTitle, schedule }) {
  const itemIds = [...new Set((ids || []).map((id) => String(id || "")).filter(Boolean))];
  if (!itemIds.length) throw new Error("请选择要认领的商品");
  const selectedIds = [...new Set((shopIds || []).map((id) => String(id || "")).filter(Boolean))];
  const snapshots = (shopList || [])
    .filter((shop) => shop?.id)
    .map((shop) => ({
      id: String(shop.id),
      name: shop.name || String(shop.id),
      platform: shop.platform || "tiktok",
      platformName: shop.platformName || "TikTok",
      site: shop.site || "TH",
      type: shop.type || "",
      isCb: shop.isCb,
      isCnsc: shop.isCnsc,
      pricingId: shop.pricingId || "",
    }));
  const store = readStore();
  const fromStore = store.shops.filter((s) => selectedIds.includes(String(s.id)));
  const shops = snapshots.length ? snapshots : fromStore;
  if (!shops.length) throw new Error("请先选择店铺");
  return addTask({
    id: uid("task"),
    kind: "claim",
    title: `平台认领 · ${itemIds.length} 个商品`,
    emoji: "▣",
    meta: `${shops.map((s) => `${s.platformName || s.platform} ${s.site}`).join(" / ")} · 从平台认领开始`,
    status: "queued",
    progress: 0,
    ok: 0,
    fail: 0,
    createdAt: now(),
    itemIds,
    shopIds: selectedIds.length ? selectedIds : shops.map((s) => String(s.id)),
    shopSnapshots: shops,
    autoPublish: autoPublish === true,
    aiTitle: aiTitle !== false,
    schedule: schedule || (autoPublish ? "now" : "manual"),
    steps: STEP_LABELS.map((label, index) => ({ label, state: index < 2 ? "done" : "wait" })),
    openaiUsage: emptyOpenAIUsage(),
  });
}

export async function runClaimTask(taskId) {
  if (!isOpenAIUsageLogActive()) return withTaskOpenAIUsage(taskId, () => runClaimTask(taskId));
  const started = Date.now();
  patchTask(taskId, { status: "running", progress: 28 });
  const snapshot = readStore();
  const task = getTask(taskId);
  if (!task) return;
  const shops = resolveTaskShops(task, snapshot);
  const settings = resolveSettings(snapshot.settings);
  const live = settings.mode === "live" && settings.appId && settings.appSecret;
  if (!live) {
    appendLog(taskId, "error", "未配置正式模式或 App Key / App Secret，已跳过认领");
    patchTask(taskId, { status: "failed", progress: 100, error: "未接妙手接口", durationMs: Date.now() - started });
    return;
  }
  appendLog(taskId, "info", `从平台认领开始 · 不采集链接 · ${task.itemIds.length} 个商品 · 店铺 ${shops.map((s) => `${s.name}(${s.id})`).join("、") || "未选"}`);
  setTaskSteps(taskId, STEP_LABELS, 2);
  const items = [];
  let missing = 0;
  for (const id of task.itemIds) {
    const item = snapshot.common.find((x) => String(x.id) === String(id) || String(x.detailId) === String(id) || String(x.boxId) === String(id));
    if (item) {
      items.push(item);
      continue;
    }
    if (Number(id) > 0) {
      items.push({ id, detailId: String(id), boxId: String(id), sourceId: "" });
      continue;
    }
    missing += 1;
    appendLog(taskId, "warn", `公共采集箱没有商品 ${id}，跳过`);
  }
  const claimed = await claimAndFillCommonItems({ snapshot, settings, task, shops, items, taskId });
  const ok = claimed.ok;
  const fail = claimed.fail + missing;
  appendLog(taskId, fail && !ok ? "error" : "info", `任务结束 · 成功 ${ok} · 异常 ${fail}`);
  patchTask(taskId, (current) => ({
    status: fail && !ok ? "failed" : fail ? "failed" : "success",
    progress: 100,
    ok,
    fail,
    error: fail && !ok ? current.error || "认领失败" : "",
    steps: STEP_LABELS.map((label) => ({ label, state: "done" })),
    durationMs: Date.now() - started,
  }));
}

export async function claimProducts(ids, shopIds, shopList = []) {
  const task = createClaimTask({ ids, shopIds, shops: shopList });
  await runClaimTask(task.id);
  return task;
}

export function publishProducts(ids) {
  let published = 0;
  writeStore((store) => {
    for (const id of ids) {
      const item = store.tiktok.find((x) => x.id === id);
      if (!item) continue;
      if (!item.shopId) {
        item.checkStatus = "fail";
        item.issues = ["缺少店铺"];
        continue;
      }
      item.checkStatus = "pass";
      item.publishStatus = "published";
      item.issues = [];
      item.publishedAt = now();
      published += 1;
    }
    store.statsToday.published += published;
    return store;
  });
  return published;
}
