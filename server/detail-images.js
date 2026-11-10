import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IMAGE_KEY = /image|img|pic|photo|thumb|banner|gallery|whitebg|white_bg|detailimg|fileurl|ossurl/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\]+/gi;

function looksLikeImageUrl(url) {
  const text = String(url || "");
  if (!/^https?:\/\//i.test(text)) return false;
  if (/\.(jpg|jpeg|png|webp|gif|bmp)(\?|$)/i.test(text)) return true;
  if (/(alicdn|tiktokcdn|byteimg|miaoshou|oss-cn|image\.|img\.)/i.test(text)) return true;
  return false;
}

function pushUrl(out, value) {
  const url = String(value || "").trim().replace(/&amp;/g, "&");
  if (looksLikeImageUrl(url)) out.add(url);
}

export function collectImageUrls(value, out = new Set(), keyHint = "") {
  if (value == null) return out;
  if (typeof value === "string") {
    if (looksLikeImageUrl(value)) pushUrl(out, value);
    const hits = value.match(URL_IN_TEXT) || [];
    for (const hit of hits) pushUrl(out, hit);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, out, keyHint);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const nextHint = IMAGE_KEY.test(key) ? key : keyHint;
      if (IMAGE_KEY.test(key) && typeof child === "string") pushUrl(out, child);
      collectImageUrls(child, out, nextHint);
    }
  }
  return out;
}

function extFromUrl(url, index) {
  const clean = String(url).split("?")[0];
  const match = clean.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i);
  return match ? `.${match[1].toLowerCase()}` : `.jpg`;
}

export function collectNotesImageUrls(info) {
  const nested = info?.shopCollectItemInfo && typeof info.shopCollectItemInfo === "object" ? info.shopCollectItemInfo : null;
  const notes = String(info?.notes || nested?.notes || "");
  const urls = [];
  const seen = new Set();
  const add = (raw) => {
    const url = String(raw || "").trim().replace(/&amp;/g, "&").replace(/^["']|["']$/g, "");
    if (!url || seen.has(url) || !looksLikeImageUrl(url)) return;
    seen.add(url);
    urls.push(url);
  };
  const tagged = notes.matchAll(/<img\b[^>]*>/gi);
  for (const [tag] of tagged) {
    const quoted = tag.match(/\bsrc\s*=\s*(["'])([^"']+)\1/i);
    if (quoted) add(quoted[2]);
    else {
      const bare = tag.match(/\bsrc\s*=\s*([^\s>]+)/i);
      if (bare) add(bare[1]);
    }
  }
  return urls;
}

export async function downloadImagesByUrls(urls, { prefix = "miaoshou-img-", unique = true } = {}) {
  let list = (urls || []).map((url) => String(url || "").trim()).filter(Boolean);
  if (unique) list = [...new Set(list)];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const files = [];
  const downloadedUrls = [];
  for (let i = 0; i < list.length; i += 1) {
    const url = list[i];
    const filename = `${String(i + 1).padStart(3, "0")}${extFromUrl(url, i)}`;
    const filePath = path.join(dir, filename);
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 32) continue;
      fs.writeFileSync(filePath, buffer);
      files.push(filePath);
      downloadedUrls.push(url);
    } catch {
      // 单张失败不影响其余图片
    }
  }
  return { dir, urls: downloadedUrls, files };
}

export async function downloadDetailImages(payload, { prefix = "miaoshou-detail-" } = {}) {
  return downloadImagesByUrls(collectNotesImageUrls(payload), { prefix });
}

export function collectSkuImageUrls(info) {
  const urls = [];
  const seen = new Set();
  const add = (value) => {
    const url = String(value || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  for (const prop of info?.skuPropertyList || []) {
    for (const item of prop?.attrValueList || []) {
      add(item?.imgUrl);
      if (Array.isArray(item?.supplementarySkuImageUrls)) {
        for (const extra of item.supplementarySkuImageUrls) add(extra);
      }
    }
  }
  return urls;
}

export function applySkuImageUrlMap(info, urlMap) {
  const next = structuredClone(info);
  const map = urlMap instanceof Map ? urlMap : new Map(Object.entries(urlMap || {}));
  for (const prop of next.skuPropertyList || []) {
    for (const item of prop?.attrValueList || []) {
      if (item?.imgUrl && map.has(item.imgUrl)) item.imgUrl = map.get(item.imgUrl);
      if (Array.isArray(item?.supplementarySkuImageUrls)) {
        item.supplementarySkuImageUrls = item.supplementarySkuImageUrls.map((url) => map.get(url) || url);
      }
    }
  }
  return next;
}

export function collectMainImageUrls(info) {
  if (!Array.isArray(info?.imgUrls)) return [];
  return info.imgUrls.map((url) => String(url || "").trim()).filter(Boolean);
}

export function applyImgUrls(info, newUrls) {
  const next = structuredClone(info);
  const originals = Array.isArray(next.imgUrls) ? next.imgUrls.map((url) => String(url || "")) : [];
  const urls = (newUrls || []).filter(Boolean);
  if (!urls.length) return next;
  next.imgUrls = originals.map((old, index) => urls[index] || old);
  if (urls.length > originals.length) next.imgUrls = [...next.imgUrls, ...urls.slice(originals.length)];
  return next;
}

export function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 临时目录清不掉就算了
  }
}

const DEFAULT_PACKAGE_CM = 15;

function emptyPackageValue(value) {
  if (value == null || value === "") return true;
  const n = Number(value);
  return !Number.isFinite(n) || n <= 0;
}

function toPackageCm(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n));
}

function pickLargestPackage(candidates) {
  let best = [null, null, null];
  let bestVol = 0;
  for (const dims of candidates) {
    if (!dims || dims.some((n) => n == null)) continue;
    const vol = dims[0] * dims[1] * dims[2];
    if (vol > bestVol) {
      best = dims;
      bestVol = vol;
    }
  }
  return best;
}

function collectPackageSizes(source) {
  const triple = /(\d+(?:\.\d+)?)\s*(?:cm|CM|厘米)?\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*(?:cm|CM|厘米)?\s*[xX×*]\s*(\d+(?:\.\d+)?)/gi;
  const named = /长\s*(\d+(?:\.\d+)?)\s*(?:cm|CM|厘米)?[^\d]{0,8}宽\s*(\d+(?:\.\d+)?)\s*(?:cm|CM|厘米)?[^\d]{0,8}高\s*(\d+(?:\.\d+)?)/gi;
  const found = [];
  for (const re of [named, triple]) {
    for (const hit of String(source || "").matchAll(re)) {
      found.push([toPackageCm(hit[1]), toPackageCm(hit[2]), toPackageCm(hit[3])]);
    }
  }
  return found;
}

export function parsePackageSizeFromText(text) {
  const plain = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const sizeChunk = plain.match(/尺寸\s*[：:]\s*([^。]+)/)?.[1] || "";
  const fromSize = pickLargestPackage(collectPackageSizes(sizeChunk));
  if (fromSize[0] != null) return fromSize;
  return pickLargestPackage(collectPackageSizes(plain));
}

export function applyPackageDimensions(info) {
  const next = structuredClone(info);
  const parsed = parsePackageSizeFromText(next.notes);
  const keys = ["packageLength", "packageWidth", "packageHeight"];
  for (let i = 0; i < keys.length; i += 1) {
    if (emptyPackageValue(next[keys[i]])) next[keys[i]] = parsed[i] ?? DEFAULT_PACKAGE_CM;
  }
  return next;
}

const DEFAULT_WEIGHT = 0.1;

export function applyDefaultWeight(info) {
  const next = structuredClone(info);
  if (emptyPackageValue(next.weight)) next.weight = DEFAULT_WEIGHT;
  if (next.skuMap && typeof next.skuMap === "object") {
    for (const sku of Object.values(next.skuMap)) {
      if (sku && typeof sku === "object" && emptyPackageValue(sku.weight)) sku.weight = DEFAULT_WEIGHT;
    }
  }
  return next;
}

export function applySaveFieldDefaults(info) {
  const next = structuredClone(info);
  next.deliveryOptionSetType = "default";
  next.sizeChartType = "";
  next.sizeChart = "";
  return next;
}

export function applyPriceTemplateId(info, pricingId) {
  const raw = String(pricingId || "").trim();
  if (!raw || raw.startsWith("price-") || raw.startsWith("tpl-")) return info;
  const next = structuredClone(info);
  const numeric = Number(raw);
  next.priceTemplateId = Number.isFinite(numeric) && String(numeric) === raw ? numeric : raw;
  return next;
}

export function applyDetailHeader(info, text) {
  const next = structuredClone(info);
  next.notes = text;
  return next;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function wrapDetailTextAsHtml(copyText) {
  return String(copyText || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

export function replaceNotesImageSrcs(notesHtml, newUrls) {
  const urls = (newUrls || []).filter(Boolean);
  let html = String(notesHtml || "");
  if (!urls.length) return html;
  if (!/<img\b/i.test(html)) {
    return urls.map((url) => `<p><img src="${String(url).replace(/"/g, "&quot;")}"></p>`).join("");
  }
  let index = 0;
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    if (index >= urls.length) return "";
    const url = String(urls[index++]).replace(/"/g, "&quot;");
    if (/\bsrc\s*=/i.test(tag)) return tag.replace(/\bsrc\s*=\s*(["'])[^"']*\1/i, `src="${url}"`);
    return tag.replace(/<img/i, `<img src="${url}"`);
  });
  const extra = urls.slice(index).map((url) => `<p><img src="${String(url).replace(/"/g, "&quot;")}"></p>`).join("");
  return `${html}${extra}`;
}

function stripEmptyParagraphs(html) {
  return String(html || "")
    .replace(/<p>(?:\s|&nbsp;)*<\/p>/gi, "")
    .replace(/^(?:\s|&nbsp;)+/, "")
    .replace(/(?:\s|&nbsp;)+$/, "");
}

export function assembleNotes(copyText, originalNotes, newImageUrls) {
  const textHtml = wrapDetailTextAsHtml(copyText);
  const imageHtml = stripEmptyParagraphs(
    newImageUrls?.length ? replaceNotesImageSrcs(originalNotes, newImageUrls) : String(originalNotes || ""),
  );
  if (!textHtml) return imageHtml;
  return `${imageHtml}${textHtml}`;
}

export function assembleInterleavedNotes(items = []) {
  const parts = [];
  for (const item of items || []) {
    const url = String(item?.url || "").trim();
    if (url) {
      parts.push(`<p><img src="${url.replace(/"/g, "&quot;")}"></p>`);
    }
    const textHtml = wrapDetailTextAsHtml(item?.text);
    if (textHtml) parts.push(textHtml);
  }
  return stripEmptyParagraphs(parts.join(""));
}
