import fs from "node:fs";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";

let client;

function getCodex() {
  if (!client) client = new Codex();
  return client;
}

function marketLabel(site) {
  const code = String(site || "TH").toUpperCase();
  if (code === "MY") return "马来西亚站中文";
  if (code === "PH") return "菲律宾站中文";
  return "泰国站中文";
}

const TITLE_MIN_CHARS = 25;
const TITLE_MAX_CHARS = 255;

function titleLength(text) {
  return [...String(text || "").trim()].length;
}

export function buildTitlePrompt(originalTitle, site) {
  return `使用 $optimize-tiktok-shop-titles 将以下原标题优化为 TikTok Shop ${marketLabel(site)}标题。
硬性要求：标题不少于 ${TITLE_MIN_CHARS} 个字符、不超过 ${TITLE_MAX_CHARS} 个字符（按字符计，含空格和标点）。不要写成过短的品名。
只输出优化后的标题，不要输出中文释义、关键词结构、合规说明或其他内容。
原标题：${originalTitle}`;
}

export function pickOriginalTitle(info) {
  const keys = ["title", "productTitle", "itemTitle", "productName", "itemName"];
  for (const key of keys) {
    if (typeof info?.[key] === "string" && info[key].trim()) return info[key].trim();
  }
  for (const key of keys) {
    if (typeof info?.itemInfo?.[key] === "string" && info.itemInfo[key].trim()) return info.itemInfo[key].trim();
  }
  return "";
}

export function applyOptimizedTitle(info, title) {
  const next = structuredClone(info);
  const keys = ["title", "productTitle", "itemTitle", "productName", "itemName"];
  let applied = false;
  for (const key of keys) {
    if (typeof next[key] === "string" && next[key].trim()) {
      next[key] = title;
      applied = true;
    }
  }
  if (next.itemInfo && typeof next.itemInfo === "object") {
    for (const key of keys) {
      if (typeof next.itemInfo[key] === "string" && next.itemInfo[key].trim()) {
        next.itemInfo[key] = title;
        applied = true;
      }
    }
  }
  if (!applied) next.title = title;
  return next;
}

function cleanTitle(text) {
  return String(text || "")
    .replace(/^```[\w]*\n?|\n?```$/g, "")
    .split(/\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/^["「『]|["」』]$/g, ""))
    .find((line) => line && !/^原标题|^优化|^说明|^关键词|^合规/.test(line)) || "";
}

export async function optimizeTitleWithCodex(originalTitle, site) {
  const title = String(originalTitle || "").trim();
  if (!title) return "";
  const thread = getCodex().startThread({
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
  });
  let result = await thread.run(buildTitlePrompt(title, site));
  let optimized = cleanTitle(result.finalResponse).slice(0, TITLE_MAX_CHARS);
  for (let attempt = 0; attempt < 2 && optimized && titleLength(optimized) < TITLE_MIN_CHARS; attempt += 1) {
    result = await thread.run(
      `上一版标题只有 ${titleLength(optimized)} 个字符，不符合要求。请在保留品类和核心卖点的前提下加长到至少 ${TITLE_MIN_CHARS} 个字符、不超过 ${TITLE_MAX_CHARS} 个字符，只输出新标题。上一版：${optimized}`,
    );
    optimized = cleanTitle(result.finalResponse).slice(0, TITLE_MAX_CHARS);
  }
  if (!optimized) throw new Error("Codex 没有返回可用标题");
  if (titleLength(optimized) < TITLE_MIN_CHARS) {
    throw new Error(`优化标题不足 ${TITLE_MIN_CHARS} 字（当前 ${titleLength(optimized)} 字）：${optimized}`);
  }
  return optimized;
}

export function buildDetailFromImagesPrompt(imageDir) {
  return `使用 $ecommerce-detail-from-images 分析我上传的商品图片${imageDir}，生成 TikTok Shop 中文详情文案。
只提取图片中明确可见的信息，不要补充未经证实的参数。`;
}

export async function generateDetailHeaderFromImages(imageDir) {
  if (!imageDir) throw new Error("没有图片目录");
  const thread = getCodex().startThread({
    workingDirectory: imageDir,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
  });
  const result = await thread.run(buildDetailFromImagesPrompt(imageDir));
  const text = String(result.finalResponse || "").trim();
  if (!text) throw new Error("Codex 没有返回详情文案");
  return text;
}

function marketForImages(site) {
  const code = String(site || "TH").toUpperCase();
  if (code === "MY") return "马来西亚站马来语";
  if (code === "PH") return "菲律宾站英语";
  return "泰国站泰语";
}

export function buildTkshopImagesPrompt(sourceDir, outputDir, site) {
  return `使用 $1688-to-tkshop-images 分析目录中的 1688 详情图：${sourceDir}
先查看全部原图，只采用图中可见、可核对的产品事实。根据有效信息决定输出张数，不要固定张数，也不要一张原图对应一张新图。合并重复卖点，拆开手机上看不清的尺寸/SKU 信息。
目标市场：TikTok Shop ${marketForImages(site)}。创意重绘，不要照搬 1688 排版；保留产品外形、颜色、结构等可见特征，不要发明配件。
把生成的详情图保存到 ${outputDir}，文件名按 01.png、02.png 顺序。
不要改写、不要输出商品详情文案。完成后只输出：张数原因一行，然后每行一个生成图片的绝对路径。`;
}

export async function generateTkshopImagesWithCodex(sourceDir, { site = "TH", outputDir = "" } = {}) {
  if (!sourceDir) throw new Error("没有详情图目录");
  const outDir = outputDir || path.join(sourceDir, "tkshop-th");
  fs.mkdirSync(outDir, { recursive: true });
  const thread = getCodex().startThread({
    workingDirectory: sourceDir,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
  });
  const result = await thread.run(buildTkshopImagesPrompt(sourceDir, outDir, site));
  const files = fs
    .readdirSync(outDir)
    .filter((name) => /\.(jpg|jpeg|png|webp|gif)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(outDir, name));
  if (!files.length) throw new Error("Codex 没有生成详情图");
  return { dir: outDir, files, log: String(result.finalResponse || "").trim() };
}

export function buildSkuImagesPrompt(sourceDir, outputDir, site) {
  const market = String(site || "TH").toUpperCase() === "TH" ? "Thailand" : String(site || "TH");
  return `使用 $ecommerce-main-image-batch 把当前目录的 SKU 源图转换成 TikTok Shop 泰国站 SKU 图。
platform: TikTok Shop
marketplace_region: ${market}
output_language: Thai
每一张源图对应生成一张输出图，保持相同顺序，不要合并、不要增删产品。源图没有促销文字就不要加文案；源图是白底就保持白底。只翻译源图里已有且可核对的文字为泰语。保存到 ${outputDir}，文件名按 001.png、002.png 与源图 001.* 对齐。不要覆盖源图。完成后只输出每行：源文件 -> 输出文件`;
}

export async function generateSkuImagesWithCodex(sourceDir, { site = "TH", outputDir = "" } = {}) {
  if (!sourceDir) throw new Error("没有 SKU 图目录");
  const outDir = outputDir || path.join(sourceDir, "sku-th");
  fs.mkdirSync(outDir, { recursive: true });
  const thread = getCodex().startThread({
    workingDirectory: sourceDir,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
  });
  const result = await thread.run(buildSkuImagesPrompt(sourceDir, outDir, site));
  const files = fs
    .readdirSync(outDir)
    .filter((name) => /\.(jpg|jpeg|png|webp|gif)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(outDir, name));
  if (!files.length) throw new Error("Codex 没有生成 SKU 图");
  return { dir: outDir, files, log: String(result.finalResponse || "").trim() };
}

export function buildMainImagesPrompt(sourceDir, outputDir, site) {
  const market = String(site || "TH").toUpperCase() === "TH" ? "Thailand" : String(site || "TH");
  return `使用 $ecommerce-main-image-batch 把当前目录的商品图批量生成为 TikTok Shop 泰国站商品图。
platform: TikTok Shop
marketplace_region: ${market}
output_language: Thai
每一张源图对应生成一张输出图，保持相同顺序，不要合并。保留商品细节、外形、颜色、材质和结构，不要发明配件或改款。
第一张源图（001）输出必须纯白底、无任何文字。
其余源图：没有促销文字就不要加文案；有文字则只把已有可核对文案译为简洁泰语；白底保持白底。
保存到 ${outputDir}，文件名按 001.png、002.png 与源图序号对齐。不要覆盖源图。完成后只输出每行：源文件 -> 输出文件`;
}

export async function generateMainImagesWithCodex(sourceDir, { site = "TH", outputDir = "" } = {}) {
  if (!sourceDir) throw new Error("没有商品图目录");
  const outDir = outputDir || path.join(sourceDir, "main-th");
  fs.mkdirSync(outDir, { recursive: true });
  const thread = getCodex().startThread({
    workingDirectory: sourceDir,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
  });
  const result = await thread.run(buildMainImagesPrompt(sourceDir, outDir, site));
  const files = fs
    .readdirSync(outDir)
    .filter((name) => /\.(jpg|jpeg|png|webp|gif)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(outDir, name));
  if (!files.length) throw new Error("Codex 没有生成商品图");
  return { dir: outDir, files, log: String(result.finalResponse || "").trim() };
}
