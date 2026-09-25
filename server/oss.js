import fs from "node:fs";
import path from "node:path";
import OSS from "ali-oss";

function ossConfig() {
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID || "";
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET || "";
  const bucket = process.env.OSS_BUCKET || "";
  const endpoint = process.env.OSS_ENDPOINT || "https://oss-cn-beijing.aliyuncs.com";
  const region = process.env.OSS_REGION || "oss-cn-beijing";
  const prefix = String(process.env.OSS_KEY_PREFIX || "images/miaoshou/").replace(/^\/+/, "");
  const publicBase = (process.env.OSS_PUBLIC_BASE || `https://${bucket}.${region}.aliyuncs.com`).replace(/\/$/, "");
  return { accessKeyId, accessKeySecret, bucket, endpoint, region, prefix, publicBase };
}

export function ossConfigured() {
  const { accessKeyId, accessKeySecret, bucket } = ossConfig();
  return Boolean(accessKeyId && accessKeySecret && bucket);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function getClient() {
  const { accessKeyId, accessKeySecret, bucket, endpoint, region } = ossConfig();
  if (!accessKeyId || !accessKeySecret || !bucket) throw new Error("未配置 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET");
  return new OSS({
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint,
    region,
    timeout: 120000,
  });
}

export async function uploadLocalImage(localPath, objectKey) {
  const client = getClient();
  const { publicBase } = ossConfig();
  const key = String(objectKey).replace(/^\/+/, "");
  await client.put(key, localPath, {
    headers: { "Content-Type": contentType(localPath) },
  });
  return `${publicBase}/${key}`;
}

export async function uploadGeneratedImages(files, { detailId = "", shopId = "", kind = "detail" } = {}) {
  const { prefix } = ossConfig();
  const stamp = Date.now();
  const folder = kind === "sku" ? "sku" : kind === "main" ? "main" : "detail";
  const urls = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const ext = path.extname(file) || ".jpg";
    const key = `${prefix}${detailId || "item"}/${shopId || "shop"}/${folder}/${stamp}-${String(i + 1).padStart(2, "0")}${ext}`;
    const url = await uploadLocalImage(file, key);
    urls.push(url);
  }
  return urls;
}

export function listImageFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /\.(jpg|jpeg|png|webp|gif)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(dir, name));
}
