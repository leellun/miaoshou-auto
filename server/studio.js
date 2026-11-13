import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runDirectDetailImageFlow, runOpenAIDetailFlow } from "./detail-flow.js";
import { runProductImageFlow } from "./product-image-flow.js";

const STUDIO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "studio");

function safeJobId(id) {
  const value = String(id || "");
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : "";
}

function decodeUpload(item, index) {
  const rawName = String(item?.filename || `image-${index + 1}.png`);
  const filename = path.basename(rawName).replace(/[^\w.\-]+/g, "_") || `image-${index + 1}.png`;
  let raw = String(item?.data || "");
  const match = raw.match(/^data:[^;]+;base64,(.+)$/s);
  if (match) raw = match[1];
  const buffer = Buffer.from(raw.replace(/\s/g, ""), "base64");
  if (!buffer.length) throw new Error(`${filename} 不是有效图片`);
  return { filename, buffer };
}

function saveUploads(list) {
  const dir = path.join(STUDIO_ROOT, `_in-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  (list || []).forEach((item, index) => {
    const { filename, buffer } = decodeUpload(item, index);
    const file = path.join(dir, `${String(index + 1).padStart(2, "0")}-${filename}`);
    fs.writeFileSync(file, buffer);
    files.push(file);
  });
  if (!files.length) throw new Error("请先上传商品图");
  return { dir, files };
}

function copyOutputs(jobId, generatedFiles) {
  const dir = path.join(STUDIO_ROOT, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const images = [];
  (generatedFiles || []).forEach((file, index) => {
    if (!file || !fs.existsSync(file)) return;
    const filename = path.basename(file) || `${String(index + 1).padStart(2, "0")}.png`;
    const dest = path.join(dir, filename);
    fs.copyFileSync(file, dest);
    images.push({
      filename,
      url: `/api/studio/jobs/${jobId}/${encodeURIComponent(filename)}`,
    });
  });
  if (!images.length) throw new Error("没有生成出图片");
  return images;
}

export function registerStudioRoutes(app) {
  app.post("/api/studio/generate", async (req, res) => {
    const logs = [];
    const onLog = (message) => {
      if (message) logs.push(String(message));
    };
    try {
      const mode = String(req.body?.mode || "main");
      const site = String(req.body?.site || "TH").toUpperCase();
      const params = {
        platform: String(req.body?.platform || "").trim(),
        country: String(req.body?.country || "").trim(),
        language: String(req.body?.language || "").trim(),
        aspect_ratio: String(req.body?.aspect_ratio || "").trim(),
        image_type: String(req.body?.image_type || "").trim(),
        excluded_copy: String(req.body?.excluded_copy || "").trim(),
        additional_copy: String(req.body?.additional_copy || "").trim(),
        redesign_strength: String(req.body?.redesign_strength || "").trim(),
        main_product: String(req.body?.main_product || "").trim(),
      };
      const uploads = saveUploads(req.body?.files);
      const jobId = randomUUID().replace(/-/g, "").slice(0, 16);
      let result;
      if (mode === "plan") {
        onLog(`规划出图 · EXTRACTION_PLAN → DETAIL_IMAGE_ANALYSIS · ${params.platform || "TikTok Shop"} · ${params.country || site} · ${uploads.files.length} 张`);
        result = await runOpenAIDetailFlow({ files: uploads.files, site, params, onLog });
      } else if (mode === "detail") {
        onLog(`详情图 · 直接分析出图 · ${params.platform || "TikTok Shop"} · ${params.country || site} · ${uploads.files.length} 张`);
        result = await runDirectDetailImageFlow({ files: uploads.files, site, params, onLog });
      } else {
        onLog(`主图/SKU · ${params.platform || "TikTok Shop"} · ${params.country || site} · ${uploads.files.length} 张`);
        result = await runProductImageFlow({ files: uploads.files, site, imageKind: "main", params, onLog });
      }
      const images = copyOutputs(jobId, result.files);
      res.json({
        jobId,
        mode,
        site,
        params,
        logs,
        images,
        report: result.report || [],
        pages: (result.pages || []).map((page) => ({
          page: page.page || page.id || "",
          filename: page.file ? path.basename(page.file) : "",
        })),
      });
    } catch (error) {
      res.status(400).json({ error: error.message || "作图失败", logs });
    }
  });

  app.get("/api/studio/jobs/:id/:file", (req, res) => {
    const id = safeJobId(req.params.id);
    const name = path.basename(String(req.params.file || ""));
    if (!id || !name) return res.status(404).json({ error: "文件不存在" });
    const file = path.resolve(STUDIO_ROOT, id, name);
    const root = path.resolve(STUDIO_ROOT, id);
    if (!file.startsWith(root) || !fs.existsSync(file)) return res.status(404).json({ error: "文件不存在" });
    res.sendFile(file);
  });
}
