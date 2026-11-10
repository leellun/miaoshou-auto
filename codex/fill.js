import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDetailHeader, assembleNotes } from "../server/detail-images.js";
import { ossConfigured, uploadGeneratedImages } from "../server/oss.js";
import {
  generateDetailHeaderFromImages,
  generateMainImagesWithCodex,
  generateSkuImagesWithCodex,
  generateTkshopImagesWithCodex,
  optimizeTitleWithCodex,
} from "./codex-title.js";

function log(onLog, level, message, extra) {
  onLog?.(level, message, extra);
}

export async function runCodexTitle({ originalTitle, site = "TH", onLog } = {}) {
  log(onLog, "info", `调用 Codex 优化标题 · ${site}`, originalTitle);
  return optimizeTitleWithCodex(originalTitle, site);
}

export async function runCodexDetail({
  downloaded,
  shop,
  detailId,
  originalNotes = "",
  shopCollectItemInfo,
  onLog,
} = {}) {
  log(onLog, "info", `调用 Codex 生成详情头部文案 · ${downloaded.dir}`);
  const headerText = await generateDetailHeaderFromImages(downloaded.dir);
  let next = applyDetailHeader(shopCollectItemInfo, assembleNotes(headerText, originalNotes, []));
  log(onLog, "info", "详情头部文案已生成", headerText.slice(0, 400));
  const generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "miaoshou-tkshop-"));
  log(onLog, "info", `调用 Codex $1688-to-tkshop-images 生成泰国站泰语详情图 · 原图 ${downloaded.dir}`);
  const generated = await generateTkshopImagesWithCodex(downloaded.dir, {
    site: shop.site || "TH",
    outputDir: generatedDir,
  });
  log(onLog, "info", `新详情图已生成 ${generated.files.length} 张到 ${generated.dir}`, generated.log.slice(0, 400));
  if (!ossConfigured()) {
    log(onLog, "warn", "未配置 OSS，本次不替换详情图地址");
  } else {
    log(onLog, "info", "开始上传详情图到阿里云 OSS");
    const imageUrls = await uploadGeneratedImages(generated.files, { detailId, shopId: shop.id });
    for (const url of imageUrls) log(onLog, "info", `OSS 图片 ${url}`);
    next = applyDetailHeader(next, assembleNotes(headerText, originalNotes, imageUrls));
  }
  return { shopCollectItemInfo: next, generatedDir };
}

export async function runCodexMainImages({ downloadedMain, shop, onLog } = {}) {
  const mainOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "miaoshou-main-th-"));
  log(onLog, "info", `调用 Codex $ecommerce-main-image-batch 生成 TikTok Shop 泰国泰语商品图 · ${downloadedMain.dir}`);
  return generateMainImagesWithCodex(downloadedMain.dir, {
    site: shop.site || "TH",
    outputDir: mainOutDir,
  });
}

export async function runCodexSkuImages({ downloadedSku, shop, onLog } = {}) {
  const skuOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "miaoshou-sku-th-"));
  log(onLog, "info", `调用 Codex $ecommerce-main-image-batch 生成 TikTok Shop 泰国泰语 SKU 图 · ${downloadedSku.dir}`);
  return generateSkuImagesWithCodex(downloadedSku.dir, {
    site: shop.site || "TH",
    outputDir: skuOutDir,
  });
}
