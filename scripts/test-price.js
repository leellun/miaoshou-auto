import "dotenv/config";
import { readStore } from "../server/store.js";
import { getPriceTemplateList, mapPriceTemplates, resolveSettings } from "../server/miaoshou.js";
import { calcPriceByTemplate, freightModeOf, mergePriceTemplate } from "../server/tiktok-th-price.js";
import { normalizeFxRates } from "../server/fx-rates.js";
import { normalizeFreightTable } from "../server/freight-table.js";

const HELP = `按妙手模板 ID 本地试算。运费类型由模板决定，不必传 --mode。

首重续重（成本 + 重量 + 尺寸）：
  node scripts/test-price.js --id 模板ID --price 20 --wReal 0.3 --L 20 --W 15 --H 10

统一运费 / 官方物流（只需成本）：
  node scripts/test-price.js --id 模板ID --price 20
`;

function parseArgs(argv) {
  const args = {
    id: "",
    price: "",
    commission: "",
    site: "TH",
    siteType: "",
    wReal: "",
    L: "",
    W: "",
    H: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--mode") i += 1;
    else if (token.startsWith("--") && next != null) {
      args[token.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

function numOrEmpty(value) {
  if (value === "" || value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`数字无效：${value}`);
  return n;
}

async function findTemplate(settings, args) {
  const remote = await getPriceTemplateList(settings, {
    name: "",
    site: args.site,
    siteType: args.siteType,
    pageNo: 1,
    pageSize: 20,
  });
  const items = mapPriceTemplates(remote);
  const hit = items.find((item) => String(item.id) === String(args.id));
  if (hit) return hit;
  console.error(`找不到模板 ${args.id}，当前列表：`);
  console.error(items.map((item) => `${item.id}\t${item.name}\t${item.siteType}\t${item.logisticsComputeType || "—"}`).join("\n") || "(空)");
  throw new Error("模板不存在");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.id) {
    console.error("缺少 --id");
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  const cost = numOrEmpty(args.price);
  if (cost == null) {
    console.error("缺少 --price");
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  const store = readStore();
  const settings = resolveSettings(store.settings);
  const remote = await findTemplate(settings, args);
  const tpl = mergePriceTemplate(remote, store.priceTemplateLocals?.[String(args.id)]);
  if (args.commission !== "") tpl.commissionPercent = numOrEmpty(args.commission);
  const mode = freightModeOf(tpl);
  const cross = tpl.buyerLogisticCharge != null && String(tpl.buyerLogisticCharge).trim() !== "";
  if (mode === "weight") {
    if (args.wReal === "") throw new Error(`模板「${tpl.name}」按重量计运费，请带上 --wReal`);
    if ((tpl.isCalLightCargo === 1 || tpl.isCalLightCargo === "1") && (args.L === "" || args.W === "" || args.H === "")) {
      throw new Error(`模板「${tpl.name}」开了抛重，请带上 --L --W --H`);
    }
  } else if (mode === "per_kg" && args.wReal === "") {
    throw new Error(`模板「${tpl.name}」按重量计费，请带上 --wReal`);
  } else if (mode === "official" && args.wReal === "") {
    throw new Error(`官方跨境物流需要重量，请带上 --wReal`);
  } else if (cross && mode !== "fixed" && args.wReal === "") {
    throw new Error(`跨境模板需要重量，请带上 --wReal`);
  }
  const result = calcPriceByTemplate(tpl, {
    cost,
    wReal: numOrEmpty(args.wReal),
    L: numOrEmpty(args.L),
    W: numOrEmpty(args.W),
    H: numOrEmpty(args.H),
    freightTable: normalizeFreightTable(store.freightTable),
    fxRates: normalizeFxRates(store.fxRates),
  });
  console.log(JSON.stringify({
    template: {
      id: tpl.id,
      name: tpl.name,
      site: `${tpl.platform || "tiktok"} / ${tpl.site} · ${tpl.siteTypeLabel || tpl.siteType}`,
      logisticsComputeType: tpl.logisticsComputeType || mode,
      input: mode === "weight" ? "成本 + 重量 + 尺寸" : mode === "per_kg" || mode === "official" ? "成本 + 重量" : "只需成本",
      profitPercent: tpl.profitPercent,
      discount: tpl.discount,
      platformChargePercent: tpl.platformChargePercent,
      paymentChargePercent: tpl.paymentChargePercent,
      withdrawChargePercent: tpl.withdrawChargePercent,
      otherCharge: tpl.otherCharge,
    },
    cost,
    ...result,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
  process.exitCode = 1;
});
