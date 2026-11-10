import crypto from "node:crypto";

export const ENDPOINTS = {
  shopList: "/open/v1/product/shop/shop/get_shop_list",
  fetchItem: "/open/v1/product/common_collect_box/common_collect_box/fetch_item",
  commonDetail: "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail",
  commonList: "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list",
  claim: "/open/v1/product/common_collect_box/common_collect_box/claimed",
  tiktokList: "/open/v1/product/collect_box/tiktok/collect_box/search_collect_box_detail_list",
  tiktokShopDetail: "/open/v1/product/collect_box/tiktok/collect_box/get_shop_collect_item_info",
  tiktokShopSave: "/open/v1/product/collect_box/tiktok/collect_box/save_shop_collect_item_info",
  tiktokSiteDetail: "/open/v1/product/collect_box/tiktok/collect_box/get_site_collect_item_info",
  tiktokSiteSave: "/open/v1/product/collect_box/tiktok/collect_box/save_site_collect_item_info",
  tiktokClaimToShop: "/open/v1/product/collect_box/tiktok/collect_box/claim_to_shop",
  tiktokBatchDelete: "/open/v1/product/collect_box/tiktok/collect_box/delete_collect_box_detail",
  commonBatchDelete: "/open/v1/product/common_collect_box/common_collect_box/batch_delete_common_collect_box_detail",
  priceTemplateList: "/open/v1/product/collect_box/tiktok/price_template/get_price_template_list",
};

/** 与 Python json.dumps(obj, ensure_ascii=False) 默认分隔符一致，签名必须用同一段 body。 */
export function dumps(value) {
  if (value === null || value === undefined) return "null";
  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return Number.isFinite(value) ? String(value) : "null";
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => dumps(item)).join(", ")}]`;
  const keys = Object.keys(value);
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${dumps(value[key])}`).join(", ")}}`;
}

export function generateSign(appSecret, path, timestamp, appKey, bodyJson = "") {
  const content = `${appSecret}${path}${timestamp}${appKey}${bodyJson}${appSecret}`;
  return crypto.createHmac("sha256", appSecret).update(content, "utf8").digest("hex");
}

export function resolveSettings(storeSettings = {}) {
  const appId = process.env.MIAOSHOU_APP_KEY || process.env.MIAOSHOU_APP_ID || storeSettings.appId || "";
  const appSecret = process.env.MIAOSHOU_APP_SECRET || storeSettings.appSecret || "";
  return {
    ...storeSettings,
    mode: process.env.MIAOSHOU_MODE || storeSettings.mode || "live",
    baseUrl: process.env.MIAOSHOU_BASE_URL || storeSettings.baseUrl || "https://openapi-erp.91miaoshou.com",
    appId,
    appSecret,
  };
}

let requestChain = Promise.resolve();
let lastRequestEndedAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRequestGapMs() {
  return 500 + Math.floor(Math.random() * 1501);
}

function enqueueMiaoshouRequest(fn) {
  const run = requestChain.then(async () => {
    if (lastRequestEndedAt) {
      const wait = nextRequestGapMs() - (Date.now() - lastRequestEndedAt);
      if (wait > 0) await sleep(wait);
    }
    try {
      return await fn();
    } finally {
      lastRequestEndedAt = Date.now();
    }
  });
  requestChain = run.then(() => {}, () => {});
  return run;
}

function isRetryableMiaoshouError(error) {
  const text = `${error?.message || ""} ${typeof error?.detail === "string" ? error.detail : JSON.stringify(error?.detail || "")}`.toLowerCase();
  return (
    text.includes("http 500") ||
    text.includes("internal error") ||
    text.includes("qps") ||
    text.includes("频率超限")
  );
}

export async function callMiaoshou({ settings, path, body = {} }) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await enqueueMiaoshouRequest(() => callMiaoshouNow({ settings, path, body }));
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !isRetryableMiaoshouError(error)) throw error;
      console.log(`[采集] warn ${path} 第 ${attempt} 次失败，准备重试：${error.message}`);
      await sleep(800 * attempt);
    }
  }
  throw lastError;
}

async function callMiaoshouNow({ settings, path, body = {} }) {
  const resolved = resolveSettings(settings);
  if (!resolved.appId || !resolved.appSecret) {
    throw new Error("未配置 App Key / App Secret");
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyJson = dumps(body);
  const sign = generateSign(resolved.appSecret, path, timestamp, resolved.appId, bodyJson);
  const url = `${resolved.baseUrl.replace(/\/$/, "")}${path}`;
  if (path.includes("price_template")) {
    console.log(`[妙手] HTTP POST ${url}`);
    console.log(`[妙手] HTTP body ${bodyJson}`);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-key": resolved.appId,
      "x-timestamp": timestamp,
      "x-sign": sign,
    },
    body: bodyJson,
  });
  const text = await response.text();
  if (path.includes("price_template")) {
    console.log(`[妙手] HTTP ${response.status} ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`妙手接口 ${path} 失败：HTTP ${response.status}`);
    err.detail = json;
    throw err;
  }
  const code = json.code ?? json.errcode ?? json.status;
  const failed =
    json.result === "fail" ||
    json.success === false ||
    (json.result !== "success" && code !== undefined && code !== 0 && code !== 200 && code !== "0" && code !== "success");
  if (failed) {
    const err = new Error(json.message || json.msg || json.errmsg || `妙手接口返回 ${code || json.result}`);
    err.detail = json;
    throw err;
  }
  return json;
}

export async function callMiaoshouData(args) {
  const json = await callMiaoshou(args);
  return json.data ?? json;
}

/** fetch_item.data.sourceItemIdAndDetailIdMap：货源 ID → 公共采集箱 ID */
export function pickSourceDetailMap(payload) {
  if (!payload || typeof payload !== "object") return {};
  const nested = payload.data && typeof payload.data === "object" ? payload.data : null;
  const raw =
    payload.sourceItemIdAndDetailIdMap ||
    payload.source_item_id_and_detail_id_map ||
    nested?.sourceItemIdAndDetailIdMap ||
    nested?.source_item_id_and_detail_id_map ||
    {};
  const map = {};
  for (const [sourceId, detailId] of Object.entries(raw)) {
    if (sourceId == null || detailId == null || detailId === "") continue;
    map[String(sourceId)] = String(detailId);
  }
  return map;
}

export function resolveDetailIdFromMap(fetchMap, sourceId, url = "") {
  if (!fetchMap || typeof fetchMap !== "object") return "";
  const direct = fetchMap[sourceId] ?? fetchMap[String(sourceId)];
  if (direct != null && direct !== "") return String(direct);
  const hit = Object.keys(fetchMap).find((key) => key && (String(url).includes(key) || String(sourceId).includes(key)));
  return hit ? String(fetchMap[hit]) : "";
}

export function fetchItem(settings, collectLinks) {
  return callMiaoshouData({
    settings,
    path: ENDPOINTS.fetchItem,
    body: { collectLinks },
  });
}

export function getCommonDetail(settings, commonCollectBoxDetailId) {
  return callMiaoshouData({
    settings,
    path: ENDPOINTS.commonDetail,
    body: { commonCollectBoxDetailId: Number(commonCollectBoxDetailId) },
  });
}

export function getCommonCollectBoxList(settings, { pageNo = 1, pageSize = 20, tabPaneName = "collectSuccess", sourceItemIdKeyword = "" } = {}) {
  const path = ENDPOINTS.commonList;
  const body = {
    pageNo,
    pageSize,
    filter: {
      tabPaneName,
      sourceItemIdKeyword: String(sourceItemIdKeyword || ""),
    },
  };
  console.log(`[采集] get_common_collect_box_list 请求 ${path} ${JSON.stringify(body)}`);
  return callMiaoshou({ settings, path, body }).then((response) => {
    console.log(`[采集] get_common_collect_box_list 返回 ${JSON.stringify(response).slice(0, 1200)}`);
    return { path, body, response };
  });
}

export function batchDeleteCommonCollectBox(settings, commonCollectBoxDetailIds) {
  const path = ENDPOINTS.commonBatchDelete;
  const ids = [...new Set((commonCollectBoxDetailIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) throw new Error("没有可删除的公共采集箱 ID");
  const body = { commonCollectBoxDetailIds: ids };
  console.log(`[采集] batch_delete_common_collect_box_detail 请求 ${path} ${JSON.stringify(body)}`);
  return callMiaoshou({ settings, path, body }).then((response) => {
    console.log(`[采集] batch_delete_common_collect_box_detail 返回 ${JSON.stringify(response).slice(0, 1200)}`);
    return { path, body, response };
  });
}

export function batchDeleteTiktokCollectBox(settings, detailIds) {
  const path = ENDPOINTS.tiktokBatchDelete;
  const ids = [...new Set((detailIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) throw new Error("没有可删除的 TK 采集箱 ID");
  const body = { detailIds: ids };
  console.log(`[采集] delete_collect_box_detail 请求 ${path} ${JSON.stringify(body)}`);
  return callMiaoshou({ settings, path, body }).then((response) => {
    console.log(`[采集] delete_collect_box_detail 返回 ${JSON.stringify(response).slice(0, 1200)}`);
    const data = response?.data && typeof response.data === "object" ? response.data : response;
    const failNum = Number(data?.failNum || 0);
    const errorMsg = String(data?.errorMsg || "").trim();
    if (failNum > 0 || errorMsg) {
      const err = new Error(errorMsg || `TK采集箱删除失败 ${failNum} 个`);
      err.detail = data;
      throw err;
    }
    return { path, body, response };
  });
}

function collectListRows(payload) {
  if (!payload || typeof payload !== "object") return [];
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  if (Array.isArray(data.detailList)) return data.detailList;
  const candidates = [
    data.list,
    data.records,
    data.rows,
    data.pageData,
    Array.isArray(data) ? data : null,
    Array.isArray(payload) ? payload : null,
  ];
  for (const list of candidates) {
    if (Array.isArray(list) && list.length) return list;
  }
  return [];
}

function pickSourceFromRow(row) {
  const first = Array.isArray(row?.sourceList) ? row.sourceList[0] : null;
  return {
    sourceId: String(row?.sourceItemId || first?.sourceItemId || ""),
    source: first?.source || "",
    url: first?.sourceItemUrl || "",
  };
}

export function mapCommonRow(row, { status = "" } = {}) {
  const detailId = String(row.commonCollectBoxDetailId ?? row.detailId ?? "");
  const source = pickSourceFromRow(row);
  const statusMap = {
    noClaimed: "unclaimed",
    claimed: "claimed",
    collectFail: "failed",
    collectSuccess: "unclaimed",
  };
  const apiStatus = String(row.status || "").toLowerCase();
  let mappedStatus = statusMap[status] || "";
  if (!mappedStatus) {
    if (apiStatus === "skip" || apiStatus === "fail" || apiStatus === "collectfail") mappedStatus = "failed";
    else if (apiStatus === "claimed") mappedStatus = "claimed";
    else mappedStatus = "unclaimed";
  }
  return {
    id: detailId,
    boxId: detailId,
    detailId,
    sourceId: source.sourceId,
    source: source.source,
    url: source.url,
    title: row.title || "",
    thumbnail: row.thumbnail || row.listThumbnail || "",
    cover: row.thumbnail || row.listThumbnail || "",
    itemNum: row.itemNum || "",
    priceMin: row.minSkuPrice ?? row.price ?? "",
    priceMax: row.maxSkuPrice ?? row.price ?? "",
    currency: "CNY",
    stock: row.stock ?? "",
    weight: row.weight ?? "",
    claimed: mappedStatus === "claimed",
    status: mappedStatus,
    group: row.commonCollectBoxGroupName || "",
    reason: row.reason || "",
    createdAt: row.gmtCreate || "",
  };
}

export function mapCommonCollectItems(payload, { status = "" } = {}) {
  return collectListRows(payload)
    .filter((row) => row && typeof row === "object")
    .map((row) => mapCommonRow(row, { status }))
    .filter((item) => item.id && item.id !== "undefined");
}

export function pickCommonCollectBoxDetailId(payload, sourceId = "", excludeIds = []) {
  const rows = collectListRows(payload);
  const want = String(sourceId || "");
  const excluded = new Set((excludeIds || []).map((id) => String(id)));
  const usable = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const detailId = row.commonCollectBoxDetailId ?? row.detailId ?? row.id;
    if (detailId == null || detailId === "") continue;
    const id = String(detailId);
    if (excluded.has(id)) continue;
    const source = pickSourceFromRow(row);
    const sourceIds = [];
    if (source.sourceId) sourceIds.push(source.sourceId);
    if (row.sourceItemId) sourceIds.push(String(row.sourceItemId));
    if (Array.isArray(row.sourceList)) {
      for (const item of row.sourceList) {
        if (item?.sourceItemId) sourceIds.push(String(item.sourceItemId));
      }
    }
    const sourceHit = !want || sourceIds.some((sid) => sid === want || sid.includes(want) || want.includes(sid));
    if (!sourceHit) continue;
    const apiStatus = String(row.status || "").toLowerCase();
    const reason = String(row.reason || "");
    const bad = apiStatus === "skip" || apiStatus === "fail" || apiStatus === "collectfail" || reason.includes("已经采集过") || reason.includes("未采集成功");
    if (bad) continue;
    usable.push({ detailId: id });
  }
  if (usable.length) return usable[0].detailId;
  return "";
}

export async function claimToPlatform(settings, detailId, platform = "tiktok", serialNumber = 1) {
  return claimToPlatforms(settings, detailId, [platform], serialNumber);
}

export async function claimToPlatforms(settings, detailId, platforms, serialNumber = 1) {
  const path = ENDPOINTS.claim;
  const list = (Array.isArray(platforms) ? platforms : [platforms])
    .map((item) => String(item?.platform || item || "").trim().toLowerCase())
    .filter(Boolean)
    .map((platform) => ({
      detailId: Number(detailId),
      platform,
      serialNumber,
    }));
  const body = { detailSerialNumberPlatformList: list };
  console.log(`[采集] claimed 请求 ${path} ${JSON.stringify(body)}`);
  const response = await callMiaoshou({ settings, path, body });
  console.log(`[采集] claimed 返回 ${JSON.stringify(response).slice(0, 1200)}`);
  return { path, body, response };
}

export function getShopList(settings, { platform = "", site = "", pageNo = 1, pageSize = 100 } = {}) {
  return callMiaoshouData({
    settings,
    path: ENDPOINTS.shopList,
    body: { platform, site, pageNo, pageSize },
  });
}

const shopListCache = new Map();

function shopCacheKey(platform, site = "") {
  return `${String(platform || "").toLowerCase()}|${String(site || "")}`;
}

export function peekShopListCache(platform, site = "") {
  return shopListCache.get(shopCacheKey(platform, site))?.items || null;
}

export async function getCachedShopList(settings, { platform = "", site = "", force = false } = {}) {
  const key = shopCacheKey(platform, site);
  if (!force && shopListCache.has(key)) return shopListCache.get(key).items;
  const remote = await getShopList(settings, { platform, site, pageNo: 1, pageSize: 100 });
  const items = mapShops(remote);
  shopListCache.set(key, { items, fetchedAt: Date.now() });
  return items;
}

export function putShopListCache(platform, site, items) {
  shopListCache.set(shopCacheKey(platform, site), { items: items || [], fetchedAt: Date.now() });
}

export function applyShopsToTiktokItems(items, shops) {
  const byId = new Map((shops || []).map((shop) => [String(shop.id), shop]));
  return (items || []).map((item) => {
    const ids = Array.isArray(item.shopIds) && item.shopIds.length ? item.shopIds : item.shopId ? [item.shopId] : [];
    const matched = ids.map((id) => byId.get(String(id))).filter(Boolean);
    if (!matched.length) return item;
    return {
      ...item,
      shopId: matched[0].id,
      shopName: matched.map((shop) => shop.name).join(" / "),
      site: item.site || matched[0].site || "",
      issues: (item.issues || []).filter((x) => x !== "缺少店铺"),
      checkStatus: (item.issues || []).filter((x) => x !== "缺少店铺").length ? item.checkStatus : "pass",
    };
  });
}

export function searchTiktokCollectList(settings, { pageNo = 1, pageSize = 20, status = "", sourceItemIdKeyword = "" } = {}) {
  const path = ENDPOINTS.tiktokList;
  const body = {
    pageNo,
    pageSize,
    filter: {},
  };
  if (status) body.filter.status = status;
  const keyword = String(sourceItemIdKeyword || "").trim().slice(0, 255);
  if (keyword) body.filter.sourceItemIdKeyword = keyword;
  console.log(`[采集] search_collect_box_detail_list 请求 ${path} ${JSON.stringify(body)}`);
  return callMiaoshou({ settings, path, body }).then((response) => {
    console.log(`[采集] search_collect_box_detail_list 返回 ${JSON.stringify(response).slice(0, 1200)}`);
    return response;
  });
}

export function mapTiktokCollectItems(payload, { status = "" } = {}) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const list = Array.isArray(data?.detailList) ? data.detailList : [];
  const statusMap = {
    notPublished: "unpublished",
    timingPublish: "scheduled",
    published: "published",
  };
  return list.map((row) => {
    const shops = Array.isArray(row.collectBoxDetailShopList) ? row.collectBoxDetailShopList : [];
    const shopId = String(shops[0]?.shopId || "");
    const detailId = String(row.collectBoxDetailId || "");
    const source = pickSourceFromRow(row);
    return {
      id: detailId,
      detailId,
      collectBoxDetailId: detailId,
      commonCollectBoxDetailId: row.commonCollectBoxDetailId ? String(row.commonCollectBoxDetailId) : "",
      itemNum: row.itemNum || "",
      sourceId: source.sourceId,
      title: row.title || "",
      thumbnail: row.thumbnail || "",
      cover: row.thumbnail || "",
      source: source.source || "1688",
      url: source.url,
      category: row.collectBoxGroupName || "",
      site: "",
      priceMin: row.price ?? "",
      priceMax: row.price ?? "",
      currency: "",
      stock: row.stock ?? "",
      shopId,
      shopIds: shops.map((shop) => String(shop.shopId || "")).filter(Boolean),
      collectBoxDetailShopList: shops,
      shopName: "",
      weight: "",
      gmtCreate: row.gmtCreate || "",
      editModel: row.editModel || "",
      platform: row.platform || "tiktok",
      remark: row.remark || "",
      copyType: row.copyType || "",
      collectBoxGroupId: row.collectBoxGroupId || "",
      collectBoxGroupName: row.collectBoxGroupName || "",
      isSupportReplicateProduct: Boolean(row.isSupportReplicateProduct),
      checkStatus: shopId ? "pass" : "fail",
      publishStatus: statusMap[status] || "unpublished",
      issues: shopId ? [] : ["缺少店铺"],
    };
  }).filter((item) => item.id && item.id !== "undefined");
}

export function getTiktokShopDetail(settings, detailId, shopId) {
  const path = ENDPOINTS.tiktokShopDetail;
  const body = { detailId: Number(detailId), shopId: Number(shopId) };
  console.log(`[采集] get_shop_collect_item_info 请求 ${path} ${JSON.stringify(body)}`);
  return callMiaoshou({ settings, path, body }).then((response) => {
    console.log(`[采集] get_shop_collect_item_info 返回 ${JSON.stringify(response).slice(0, 1200)}`);
    return response.data ?? response;
  });
}

export function getTiktokSiteDetail(settings, detailId, site) {
  const path = ENDPOINTS.tiktokSiteDetail;
  const body = { detailId: Number(detailId), site: String(site || "").trim() };
  console.log(`[采集] get_site_collect_item_info 请求 ${path} ${JSON.stringify(body)}`);
  return callMiaoshou({ settings, path, body }).then((response) => {
    console.log(`[采集] get_site_collect_item_info 返回 ${JSON.stringify(response).slice(0, 1200)}`);
    return response.data ?? response;
  });
}

export function saveTiktokShopDetail(settings, { detailId, shopId, shopCollectItemInfo, ossMd5 = "" }) {
  const path = ENDPOINTS.tiktokShopSave;
  const body = {
    ossMd5,
    shopCollectItemInfo,
    detailId: Number(detailId),
    shopId: Number(shopId),
  };
  console.log(`[采集] save_shop_collect_item_info 请求 ${path} detailId=${body.detailId} shopId=${body.shopId}`);
  return callMiaoshou({ settings, path, body }).then((response) => {
    console.log(`[采集] save_shop_collect_item_info 返回 ${JSON.stringify(response).slice(0, 1200)}`);
    return response.data ?? response;
  });
}

export function saveTiktokSiteDetail(settings, { detailId, site, shopCollectItemInfo, ossMd5 = "" }) {
  const path = ENDPOINTS.tiktokSiteSave;
  const body = {
    ossMd5,
    shopCollectItemInfo,
    detailId: Number(detailId),
    site: String(site || "").trim(),
  };
  console.log(`[采集] save_site_collect_item_info 请求 ${path} detailId=${body.detailId} site=${body.site}`);
  return callMiaoshou({ settings, path, body }).then((response) => {
    console.log(`[采集] save_site_collect_item_info 返回 ${JSON.stringify(response).slice(0, 1200)}`);
    return response.data ?? response;
  });
}

export function claimTiktokToShop(settings, { detailIds = [], shopIds = [] }) {
  const path = ENDPOINTS.tiktokClaimToShop;
  const body = {
    detailIds: (detailIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
    shopIds: (shopIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
  };
  console.log(`[采集] claim_to_shop 请求 ${path} ${JSON.stringify(body)}`);
  return callMiaoshou({ settings, path, body }).then((response) => {
    console.log(`[采集] claim_to_shop 返回 ${JSON.stringify(response).slice(0, 1200)}`);
    return response.data ?? response;
  });
}

export function hasBuyerLogisticCharge(item) {
  return item?.buyerLogisticCharge != null && String(item.buyerLogisticCharge).trim() !== "";
}

export function inferPriceSiteType(item) {
  if (hasBuyerLogisticCharge(item)) return "cross_border";
  if (item?.siteType === "cross_border" || item?.siteType === "mainland") return item.siteType;
  return "mainland";
}

export async function getPriceTemplateList(settings, { name = "", site = "", pageNo = 1, pageSize = 100 } = {}) {
  const body = {
    name,
    site,
    pageNo,
    pageSize,
  };
  const data = await callMiaoshouData({
    settings,
    path: ENDPOINTS.priceTemplateList,
    body,
  });
  return data;
}

const PRICE_TEMPLATE_TTL_MS = 10 * 60 * 1000;
const priceTemplateListCache = new Map();

function priceTemplateCacheKey({ name = "", site = "", pageNo = 1, pageSize = 20 } = {}) {
  return `${name}|${site}|${pageNo}|${pageSize}`;
}

export function peekPriceTemplateCache(query = {}) {
  return priceTemplateListCache.get(priceTemplateCacheKey(query))?.items || null;
}

export async function getCachedPriceTemplateList(settings, opts = {}) {
  const query = {
    name: opts.name || "",
    site: opts.site || "",
    pageNo: opts.pageNo || 1,
    pageSize: opts.pageSize || 20,
  };
  const key = priceTemplateCacheKey(query);
  const hit = priceTemplateListCache.get(key);
  if (!opts.force && hit && Date.now() - hit.fetchedAt < PRICE_TEMPLATE_TTL_MS) {
    return { items: hit.items, fromCache: true };
  }
  const remote = await getPriceTemplateList(settings, query);
  const items = mapPriceTemplates(remote);
  priceTemplateListCache.set(key, { items, fetchedAt: Date.now() });
  console.log(`items template：${JSON.stringify(items)}`)
  return { items, fromCache: false };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return undefined;
}

export function mapPriceTemplates(remote) {
  const list = remote?.priceTemplateList || remote?.list || remote?.records || (Array.isArray(remote) ? remote : []);
  return list.map((item, index) => {
    const out = {};
    for (const [key, value] of Object.entries(item || {})) {
      if (value == null || value === "") continue;
      out[key] = value;
    }
    const siteType = inferPriceSiteType(out);
    out.id = String(item.priceTemplateId ?? item.id ?? item.templateId ?? `tpl-${index}`);
    out.name = item.name || item.templateName || `定价模板 ${index + 1}`;
    if (!out.platform) out.platform = "tiktok";
    out.siteType = siteType;
    if (siteType === "cross_border" || siteType === "mainland") {
      out.siteTypeLabel = siteType === "cross_border" ? "跨境" : "本土";
    }
    const vat = pickFirst(out.vatChargePercent, item.vatPercent);
    if (vat != null) out.vatChargePercent = vat;
    const tariff = pickFirst(out.tariffChargePercent, item.tariffPercent);
    if (tariff != null) out.tariffChargePercent = tariff;
    if (item.weightSource === "sku" || item.weightSource === "package") out.weightSource = item.weightSource;
    return out;
  });
}

function flag01(value) {
  return value === 1 || value === "1" || value === true ? 1 : 0;
}

export function mapShops(remote) {
  const list = remote?.list || remote?.records || remote?.shopList || (Array.isArray(remote) ? remote : []);
  return list.map((item) => {
    const isCb = flag01(item.isCb);
    const isCnsc = flag01(item.isCnsc);
    return {
      id: String(item.shopId ?? item.id ?? item.shop_id),
      platform: String(item.platform || item.platformCode || "tiktok").toLowerCase(),
      platformName: item.platformName || (String(item.platform || "tiktok").toLowerCase() === "tiktok" ? "TikTok" : item.platform),
      site: item.site || item.country || item.region || "",
      siteName: item.siteName || "",
      name: item.platformShopName || item.shopName || item.name || item.shop_name || item.shopNick || String(item.shopId),
      shopNick: item.shopNick || "",
      parentShopId: item.parentShopId == null || item.parentShopId === "" ? "" : String(item.parentShopId),
      isCb,
      isCnsc,
      type: isCb ? "跨境" : "本土",
      gmtExpire: item.gmtExpire || "",
      gmtLastAuth: item.gmtLastAuth || "",
      status: item.status === "normal" ? "authorized" : (item.status || "authorized"),
    };
  }).filter((item) => item.id && item.id !== "undefined");
}
