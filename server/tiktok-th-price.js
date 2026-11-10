import { calcCrossBorderFreight, calcCrossBorderPrice } from "./cross-border-price.js";

export const DEFAULT_LOCAL_PRICE = {
  commissionPercent: 5,
  growthPercent: 6.42,
  fixedInfraFee: 0.22,
  vatChargePercent: 0,
  tariffChargePercent: 0,
  profitType: "sale",
  priceProcessDecimalType: "round",
};

export function normalizeWeightSource(value) {
  const t = String(value || "").toLowerCase();
  if (t === "sku" || t.includes("sku")) return "sku";
  if (t === "package" || t.includes("包裹") || t.includes("package")) return "package";
  return "";
}

export function normalizeProfitType(value) {
  const t = String(value || "").toLowerCase();
  if (t.includes("cost") || t.includes("成本")) return "cost";
  if (t.includes("fix") || t.includes("固定")) return "fixed";
  if (t.includes("sale") || t.includes("售价")) return "sale";
  return t === "cost" || t === "fixed" ? t : "sale";
}

export function normalizeDecimalType(value) {
  const t = String(value || "").toLowerCase();
  if (t === "floor" || t.includes("向下")) return "floor";
  if (t === "ceil" || t.includes("向上")) return "ceil";
  return "round";
}

export function normalizeLogisticsType(value) {
  const t = String(value || "").trim();
  if (!t) return "";
  if (t === "first_continued") return "first_continued";
  if (t === "byWeightAndFixedCharge" || t === "weight_interval" || /byweightandfixed/i.test(t)) return "byWeightAndFixedCharge";
  if (t === "official_freight_tpl" || t === "officialFreightTpl") return "official_freight_tpl";
  if (t === "fixed") return "fixed";
  return t;
}

function fromApi(value) {
  return value != null && value !== "";
}

function apiFields(remote = {}) {
  const out = {};
  for (const [key, value] of Object.entries(remote)) {
    if (fromApi(value)) out[key] = value;
  }
  return out;
}

export function compactPriceFields(item) {
  const out = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (value == null || value === "") continue;
    out[key] = value;
  }
  return out;
}

export function pickValuedPriceFields(item) {
  const skip = new Set(["fieldLocked"]);
  const out = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (skip.has(key)) continue;
    if (value == null || value === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (typeof value === "object") continue;
    out[key] = value;
  }
  return out;
}

export function mergePriceTemplate(remote, local = {}) {
  const fromRemote = apiFields(remote);
  const fromLocal = pickValuedPriceFields(local);
  const next = compactPriceFields({
    ...DEFAULT_LOCAL_PRICE,
    ...fromRemote,
    ...fromLocal,
    id: String(remote.id || fromLocal.id || ""),
  });
  const profitSrc = fromLocal.profitType || fromRemote.profitType;
  const decimalSrc = fromLocal.priceProcessDecimalType || fromRemote.priceProcessDecimalType;
  if (fromApi(profitSrc)) next.profitType = normalizeProfitType(profitSrc);
  else next.profitType = DEFAULT_LOCAL_PRICE.profitType;
  if (fromApi(decimalSrc)) next.priceProcessDecimalType = normalizeDecimalType(decimalSrc);
  else next.priceProcessDecimalType = DEFAULT_LOCAL_PRICE.priceProcessDecimalType;
  const weightSrc = fromLocal.weightSource || fromRemote.weightSource;
  if (fromApi(weightSrc)) next.weightSource = normalizeWeightSource(weightSrc) || weightSrc;
  if (!fromApi(fromRemote.vatChargePercent) && !fromApi(fromRemote.vatPercent) && !fromApi(fromLocal.vatChargePercent)) {
    next.vatChargePercent = DEFAULT_LOCAL_PRICE.vatChargePercent;
  }
  if (!fromApi(fromRemote.tariffChargePercent) && !fromApi(fromRemote.tariffPercent) && !fromApi(fromLocal.tariffChargePercent)) {
    next.tariffChargePercent = DEFAULT_LOCAL_PRICE.tariffChargePercent;
  }
  return compactPriceFields(next);
}

function round(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  return Number(n.toFixed(digits));
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rateFromPercent(value) {
  const n = num(value);
  if (n == null) return 0;
  return n / 100;
}

function discountRate(value) {
  const n = num(value, 10);
  if (n > 10) return n / 100;
  if (n > 1) return n / 10;
  if (n > 0) return n;
  return 1;
}

export function isCrossBorderTemplate(tpl) {
  const type = String(tpl?.siteType || "").toLowerCase();
  if (type === "cross_border" || type === "跨境") return true;
  if (type === "mainland" || type === "本土") return false;
  return tpl?.buyerLogisticCharge != null && String(tpl.buyerLogisticCharge).trim() !== "";
}

export function priceKindOfShop(shop) {
  if (shop?.isCb === 1 || shop?.isCb === "1" || shop?.isCb === true) return "cross_border";
  if (shop?.isCb === 0 || shop?.isCb === "0" || shop?.isCb === false) return "mainland";
  return "";
}

export function isOfficialFreightTpl(tpl) {
  return normalizeLogisticsType(tpl?.logisticsComputeType) === "official_freight_tpl";
}

export function isLightCargoOn(tpl) {
  return tpl?.isCalLightCargo === 1 || tpl?.isCalLightCargo === "1" || tpl?.isCalLightCargo === true;
}

export function freightModeOf(tpl) {
  const type = normalizeLogisticsType(tpl?.logisticsComputeType || tpl?.logisticsType);
  if (type === "official_freight_tpl") return "official";
  if (type === "byWeightAndFixedCharge") return "per_kg";
  if (type === "first_continued") return "weight";
  if (type === "fixed") return "fixed";
  if (!type && tpl?.firstWeightCharge != null && tpl?.firstWeightInterval != null) return "weight";
  return "fixed";
}

export function perKgRateOf(tpl) {
  return num(tpl?.firstWeightCharge, 0) || 0;
}

export function perKgFixedOf(tpl) {
  return num(tpl?.continuedWeightCharge, 0) || 0;
}

function ceilUnits(weight, interval) {
  const step = Number(interval) || 1;
  if (!(weight > 0) || !(step > 0)) return 0;
  return Math.ceil(weight / step - 1e-12);
}

export function calcFirstMileByWeight(tpl, dims = {}) {
  const wReal = num(dims.wReal);
  if (wReal == null) throw new Error("当前运费类型需要重量");
  let volWeight = null;
  let chargeWeight = wReal;
  const firstContinued = normalizeLogisticsType(tpl?.logisticsComputeType || tpl?.logisticsType) !== "byWeightAndFixedCharge";
  if (firstContinued && isLightCargoOn(tpl)) {
    const L = num(dims.L);
    const W = num(dims.W);
    const H = num(dims.H);
    if (L == null || W == null || H == null) throw new Error("计算抛重需要长宽高");
    const coeff = num(tpl.lightCargoCoefficient, 8000) || 8000;
    volWeight = (L * W * H) / coeff;
    chargeWeight = Math.max(wReal, volWeight);
  }
  const firstW = num(tpl.firstWeightInterval, 1) || 1;
  const firstPrice = num(tpl.firstWeightCharge, 0) || 0;
  const step = num(tpl.continuedWeightInterval, 1) || 1;
  const continuePrice = num(tpl.continuedWeightCharge, 0) || 0;
  const firstUnits = ceilUnits(Math.min(chargeWeight, firstW), firstW);
  const extraUnits = chargeWeight > firstW ? ceilUnits(chargeWeight - firstW, step) : 0;
  const firstMile = firstUnits * firstPrice + extraUnits * continuePrice;
  return { firstMile, chargeWeight, volWeight };
}

/** 按重量计费：头程 = 实重(kg) × firstWeightCharge + continuedWeightCharge。 */
export function calcFirstMileByKg(tpl, dims = {}) {
  const wReal = num(dims.wReal);
  if (wReal == null) throw new Error("按重量计费需要重量");
  const firstMile = wReal * perKgRateOf(tpl) + perKgFixedOf(tpl);
  return { firstMile, chargeWeight: wReal, volWeight: null };
}

function emptyLastMile() {
  return { lastMile: 0, lastMileSeller: 0, lastMileBuyer: 0, firstMileLocal: null, firstMileCurrency: "" };
}

/** 本土运费：统一运费，或首重续重（未满一档向上取整）。无尾程。 */
export function calcMainlandFreight(tpl, dims = {}) {
  const mode = freightModeOf(tpl);
  if (mode === "weight") {
    const { firstMile, chargeWeight, volWeight } = calcFirstMileByWeight(tpl, dims);
    return { mode: "weight", freight: firstMile, firstMile, chargeWeight, volWeight, ...emptyLastMile() };
  }
  if (mode === "per_kg") {
    const { firstMile, chargeWeight, volWeight } = calcFirstMileByKg(tpl, dims);
    return { mode: "per_kg", freight: firstMile, firstMile, chargeWeight, volWeight, ...emptyLastMile() };
  }
  const firstMile = num(tpl.logisticsCharge, 0) || 0;
  return { mode: "fixed", freight: firstMile, firstMile, chargeWeight: null, volWeight: null, ...emptyLastMile() };
}

export function calcFreightFromTemplate(tpl, dims = {}, ctx = {}) {
  return isCrossBorderTemplate(tpl)
    ? calcCrossBorderFreight(tpl, dims, ctx)
    : calcMainlandFreight(tpl, dims);
}

/**
 * 最初贴的 TikTok 泰国售价利润率公式（费率可由模板代入）：
 * sumRate = 利润率 + 平台佣金 + 支付 + 提现 + 增长 + 达人佣金
 * 折后 = (采购 + 运费 + 基建费 + 其他) / (1 - sumRate)
 * 折前 = 折后 / 折扣
 * 利润 = 折后 * 利润率
 */
export function calcTiktokThPrice(cost, commissionRate, otherFee, freightCfg, rates = {}) {
  const profitRate = num(rates.profitRate, 0.3) ?? 0.3;
  const platformRate = num(rates.platformRate, 0.0749) ?? 0.0749;
  const payRate = num(rates.payRate, 0.0321) ?? 0.0321;
  const withdrawRate = num(rates.withdrawRate, 0.01) ?? 0.01;
  const growthRate = num(rates.growthRate, 0.0642) ?? 0.0642;
  const fixedInfraFee = num(rates.fixedInfraFee, 0.22) ?? 0.22;
  const discount = num(rates.discount, 0.6) ?? 0.6;
  const vatRate = num(rates.vatRate, 0) || 0;
  const tariffRate = num(rates.tariffRate, 0) || 0;
  const sumRate = profitRate + platformRate + payRate + withdrawRate + growthRate + Number(commissionRate) + vatRate + tariffRate;

  let freight;
  let chargeWeight = null;
  let volWeight = null;
  if (freightCfg.type === "weight") {
    volWeight = freightCfg.L * freightCfg.W * freightCfg.H / freightCfg.coeff;
    chargeWeight = Math.max(freightCfg.wReal, volWeight);
    const step = Number(freightCfg.step) || 1;
    const firstW = freightCfg.firstW;
    const firstUnits = ceilUnits(Math.min(chargeWeight, firstW), firstW);
    const extraUnits = chargeWeight > firstW ? ceilUnits(chargeWeight - firstW, step) : 0;
    freight = firstUnits * freightCfg.firstPrice + extraUnits * freightCfg.continuePrice;
  } else {
    freight = Number(freightCfg.freight);
  }

  const totalFixedCost = Number(cost) + freight + fixedInfraFee + Number(otherFee);
  const priceAfterDiscount = totalFixedCost / (1 - sumRate);
  const priceOriginal = priceAfterDiscount / discount;
  const profit = priceAfterDiscount * profitRate;
  return {
    priceOriginal: Number(priceOriginal.toFixed(2)),
    priceAfterDiscount: Number(priceAfterDiscount.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    freight: Number(freight.toFixed(2)),
    chargeWeight: chargeWeight != null ? Number(chargeWeight.toFixed(4)) : null,
    volWeight: volWeight != null ? Number(volWeight.toFixed(4)) : null,
    rates: { profitRate, platformRate, payRate, withdrawRate, growthRate, commissionRate: Number(commissionRate), vatRate, tariffRate, discount, otherFee: Number(otherFee), fixedInfraFee, sumRate },
  };
}

function readTemplateRates(tpl, { vat = false } = {}) {
  return {
    profitMode: normalizeProfitType(tpl.profitType),
    profitRate: rateFromPercent(tpl.profitPercent),
    profitAmount: num(tpl.profitPercent, 0) || 0,
    platformRate: rateFromPercent(tpl.platformChargePercent),
    payRate: rateFromPercent(tpl.paymentChargePercent),
    withdrawRate: rateFromPercent(tpl.withdrawChargePercent),
    growthRate: rateFromPercent(tpl.growthPercent ?? DEFAULT_LOCAL_PRICE.growthPercent),
    commissionRate: rateFromPercent(tpl.commissionPercent ?? DEFAULT_LOCAL_PRICE.commissionPercent),
    vatRate: vat ? rateFromPercent(tpl.vatChargePercent ?? tpl.vatPercent) : 0,
    tariffRate: vat ? rateFromPercent(tpl.tariffChargePercent ?? tpl.tariffPercent) : 0,
    discount: discountRate(tpl.discount),
    otherFee: num(tpl.otherCharge, 0) || 0,
    fixedInfraFee: num(tpl.fixedInfraFee, DEFAULT_LOCAL_PRICE.fixedInfraFee) ?? DEFAULT_LOCAL_PRICE.fixedInfraFee,
  };
}

function finishPrice(cost, freightInfo, rates) {
  const {
    profitMode, profitRate, profitAmount, platformRate, payRate, withdrawRate,
    growthRate, commissionRate, vatRate, tariffRate, discount, otherFee, fixedInfraFee,
  } = rates;
  const feeSum = platformRate + payRate + withdrawRate + growthRate + commissionRate + vatRate + tariffRate;
  const sumRate = profitMode === "sale" ? profitRate + feeSum : feeSum;
  if (sumRate >= 1) throw new Error(`费率合计 ${(sumRate * 100).toFixed(2)}% 必须小于 100%`);
  const extras = freightInfo.freight + fixedInfraFee + otherFee;
  let numer = Number(cost) + extras;
  if (profitMode === "cost") numer = Number(cost) * (1 + profitRate) + extras;
  else if (profitMode === "fixed") numer = Number(cost) + profitAmount + extras;
  const priceAfterDiscount = numer / (1 - sumRate);
  const priceOriginal = priceAfterDiscount / discount;
  const profit = profitMode === "fixed" ? profitAmount : profitMode === "cost" ? Number(cost) * profitRate : priceAfterDiscount * profitRate;
  const after = priceAfterDiscount;
  const fees = {
    freight: round(freightInfo.freight, 2),
    firstMile: round(freightInfo.firstMile, 2),
    firstMileLocal: freightInfo.firstMileLocal == null ? null : round(freightInfo.firstMileLocal, 2),
    firstMileCurrency: freightInfo.firstMileCurrency || "",
    lastMileSeller: round(freightInfo.lastMileSeller || 0, 2),
    lastMileBuyer: round(freightInfo.lastMileBuyer || 0, 2),
    platform: round(after * platformRate, 2),
    payment: round(after * payRate, 2),
    withdraw: round(after * withdrawRate, 2),
    commission: round(after * commissionRate, 2),
    infra: round(fixedInfraFee, 2),
    growth: round(after * growthRate, 2),
    vat: round(after * vatRate, 2),
    tariff: round(after * tariffRate, 2),
    cost: round(Number(cost), 2),
    other: round(otherFee, 2),
  };
  fees.tiktokPlatform = round(fees.platform + fees.payment + fees.withdraw + fees.commission + fees.infra + fees.growth + fees.vat + fees.tariff, 2);
  return {
    kind: rates.kind,
    mode: freightInfo.mode,
    priceOriginal: round(priceOriginal, 2),
    priceAfterDiscount: round(priceAfterDiscount, 2),
    profit: round(profit, 2),
    freight: fees.freight,
    chargeWeight: freightInfo.chargeWeight == null ? null : round(freightInfo.chargeWeight, 4),
    volWeight: freightInfo.volWeight == null ? null : round(freightInfo.volWeight, 4),
    fees,
    rates: { profitRate, platformRate, payRate, withdrawRate, growthRate, commissionRate, vatRate, tariffRate, discount, otherFee, fixedInfraFee, sumRate },
  };
}

/** 本土：无增值税/关税、无跨境运费表、无尾程。 */
export function calcMainlandPrice(tpl, input = {}) {
  const rates = { ...readTemplateRates(tpl, { vat: false }), kind: "mainland" };
  const freightInfo = calcMainlandFreight(tpl, input);
  return finishPrice(input.cost, freightInfo, rates);
}

export { calcCrossBorderFreight, calcCrossBorderPrice };

export function calcPriceByTemplate(tpl, input = {}) {
  const kind = input.kind === "cross_border" || input.kind === "mainland"
    ? input.kind
    : (isCrossBorderTemplate(tpl) ? "cross_border" : "mainland");
  return kind === "cross_border" ? calcCrossBorderPrice(tpl, input) : calcMainlandPrice(tpl, input);
}

function skuWeightOf(sku, packageWeight, weightSource) {
  if (normalizeWeightSource(weightSource) === "sku") {
    const w = num(sku?.weight);
    if (w == null) throw new Error("SKU 没有 weight");
    return w;
  }
  const w = num(packageWeight);
  if (w == null) throw new Error("包裹没有 weight");
  return w;
}

/**
 * 货源 originPrice = 成本；模板算出原价写入 sku.price（税前售价）。
 * 重量：skuMap.weight 为 SKU 重，最外层 weight 为包裹重；长宽高取 packageLength/Width/Height。
 */
export function applySkuPricesFromTemplate(info, tpl, ctx = {}) {
  if (!tpl) throw new Error("没有定价模板，无法计算售价");
  const next = structuredClone(info);
  const skuMap = next.skuMap;
  if (!skuMap || typeof skuMap !== "object" || !Object.keys(skuMap).length) {
    throw new Error("详情没有 skuMap，无法定价");
  }
  const L = num(next.packageLength);
  const W = num(next.packageWidth);
  const H = num(next.packageHeight);
  const rows = [];
  for (const [key, sku] of Object.entries(skuMap)) {
    if (!sku || typeof sku !== "object") continue;
    const cost = num(sku.originPrice);
    if (cost == null) throw new Error(`SKU ${key} 没有 originPrice 成本`);
    const wReal = skuWeightOf(sku, next.weight, tpl.weightSource);
    const result = calcPriceByTemplate(tpl, {
      cost,
      wReal,
      L,
      W,
      H,
      kind: ctx.kind,
      freightTable: ctx.freightTable,
      fxRates: ctx.fxRates,
    });
    sku.price = result.priceOriginal;
    rows.push({
      key,
      cost,
      wReal,
      price: result.priceOriginal,
      after: result.priceAfterDiscount,
    });
  }
  if (!rows.length) throw new Error("skuMap 没有可定价的 SKU");
  return { info: next, rows };
}
