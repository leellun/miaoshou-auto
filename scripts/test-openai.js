import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateTitle, hasOpenAIConfig } from "../server/openai-api.js";
import {
  composeDetailImages,
  extractionPlanDetailImages,
  generateDetailImages,
} from "../server/detail-flow.js";
import { runProductGenerate } from "../server/product-image-flow.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

const HELP = `分开测试 OpenAI 详情链路（每步一次交互，结果写入 --work 或 --out）。

详情图：
  node scripts/test-openai.js --step analyze --input 原图目录 --out data/openai-test/run1
  node scripts/test-openai.js --step compose --work data/openai-test/run1
  node scripts/test-openai.js --step generate --work data/openai-test/run1
  node scripts/test-openai.js --step generate --work data/openai-test/run1 --page page_01

标题 / 主图 / SKU：
  node scripts/test-openai.js --step title --title "原标题"
  node scripts/test-openai.js --step product --kind main --input 主图目录 --out data/openai-test/main1
  node scripts/test-openai.js --step product --kind sku --input SKU目录 --out data/openai-test/sku1
  node scripts/test-openai.js --step product --kind main --work data/openai-test/main1 --file 001.jpg
`;

function parseArgs(argv) {
  const args = {
    step: "",
    site: "TH",
    title: "",
    input: "",
    out: "",
    work: "",
    page: "",
    kind: "main",
    file: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token.startsWith("--") && next) {
      args[token.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

function listImages(dir) {
  if (!dir) return [];
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`输入目录不存在：${abs}`);
  return fs.readdirSync(abs)
    .filter((name) => IMAGE_EXT.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(abs, name));
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) throw new Error(`缺少文件：${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function copyFiles(files, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return (files || []).map((file) => {
    const dest = path.join(destDir, path.basename(file));
    fs.copyFileSync(file, dest);
    return dest;
  });
}

function log(message, extra) {
  console.log(message);
  if (extra == null || extra === "") return;
  const text = typeof extra === "string" ? extra : JSON.stringify(extra, null, 2);
  if (text && text !== "{}" && text !== "[]") console.log(text.slice(0, 1200));
}

function resolveWork(args) {
  if (args.work) {
    const dir = path.resolve(args.work);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.resolve(args.out || path.join(root, "data", "openai-test", stamp));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sourceImages(work, input) {
  const cached = path.join(work, "source");
  if (fs.existsSync(cached) && listImages(cached).length) return listImages(cached);
  return listImages(input);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.step) {
    console.log(HELP);
    if (!args.step) process.exitCode = 1;
    return;
  }
  const step = String(args.step).toLowerCase();
  const work = resolveWork(args);
  console.log(`工作目录 ${work}`);
  if (step !== "compose" && !hasOpenAIConfig()) throw new Error("未配置 OPENAI_API_KEY，无法测试");
  if (step !== "compose") console.log(`步骤 ${step}（每次 OpenAI 交互会在 data/openai-logs/ 单独写一个 log）`);
  else console.log(`步骤 ${step}（本地按 plan 裁切竖拼，不调用 OpenAI）`);

  if (step === "title") {
    const original = String(args.title || "").trim();
    if (!original) throw new Error("请传 --title");
    const title = await generateTitle({ originalTitle: original, site: args.site });
    fs.writeFileSync(path.join(work, "title.txt"), `${title}\n`, "utf8");
    console.log(title);
    return;
  }

  if (step === "analyze" || step === "plan" || step === "extract-plan") {
    const files = sourceImages(work, args.input);
    if (!files.length) throw new Error("extract-plan 请传 --input 原图目录，或使用已有 --work/source");
    const sourceDir = path.join(work, "source");
    const saved = fs.existsSync(sourceDir) && listImages(sourceDir).length
      ? listImages(sourceDir)
      : copyFiles(files, sourceDir);
    const { extract, plan } = await extractionPlanDetailImages({
      files: saved,
      productId: path.basename(work),
      site: args.site,
      onLog: log,
    });
    writeJson(path.join(work, "extract.json"), extract);
    writeJson(path.join(work, "plan.json"), plan);
    console.log(`已写入 ${path.join(work, "extract.json")} · ${extract.images.length} 张`);
    console.log(`已写入 ${path.join(work, "plan.json")} · ${plan.image_count} 页`);
    return;
  }

  if (step === "compose") {
    const extract = readJson(path.join(work, "extract.json"));
    const plan = readJson(path.join(work, "plan.json"));
    const files = sourceImages(work, args.input);
    if (!files.length) throw new Error("compose 需要 --work 下的 source 目录，或再传 --input");
    const dest = path.join(work, args.page ? `compose-${args.page}` : "compose");
    const flow = await composeDetailImages({
      plan,
      extract,
      files,
      outputDir: dest,
      pageId: args.page,
      onLog: log,
    });
    console.log(`已本地拼接 ${flow.files.length} 张 → ${dest}${args.page ? `（仅 ${args.page}）` : ""}`);
    return;
  }

  if (step === "generate") {
    const extract = readJson(path.join(work, "extract.json"));
    const plan = readJson(path.join(work, "plan.json"));
    const files = sourceImages(work, args.input);
    if (!files.length) throw new Error("generate 需要 --work 下的 source 目录，或再传 --input");
    const dest = path.join(work, args.page ? `generate-${args.page}` : "generate");
    const flow = await generateDetailImages({
      plan,
      extract,
      files,
      outputDir: dest,
      pageId: args.page,
      onLog: log,
    });
    console.log(`已生成 ${flow.files.length} 张 → ${dest}${args.page ? `（仅 ${args.page}）` : ""}`);
    return;
  }

  if (step === "product" || step === "product-generate") {
    const files = sourceImages(work, args.input);
    if (!files.length) throw new Error("product 请传 --input 或已有 --work/source");
    const sourceDir = path.join(work, "source");
    const saved = fs.existsSync(sourceDir) && listImages(sourceDir).length
      ? listImages(sourceDir)
      : copyFiles(files, sourceDir);
    const dest = path.join(work, args.file ? `generate-${path.parse(args.file).name}` : "generate");
    const generated = await runProductGenerate({
      files: saved,
      site: args.site,
      imageKind: args.kind,
      outputDir: dest,
      onlyFilename: args.file,
      onLog: log,
    });
    console.log(`已生成 ${generated.files.length} 张 → ${dest}`);
    return;
  }

  throw new Error(`未知 --step ${args.step}\n${HELP}`);
}

main().catch((error) => {
  console.error(error.message);
  if (error.detail) console.error(JSON.stringify(error.detail).slice(0, 1000));
  process.exitCode = 1;
});
