import { calcParcelFreightCny } from "./freight-table.js";
import {
  DEFAULT_LOCAL_PRICE,
  calcFirstMileByKg,
  calcFirstMileByWeight,
  freightModeOf,
  isCrossBorderTemplate,
  isOfficialFreightTpl,
  normalizeProfitType,
} from "./tiktok-th-price.js";

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

function isYes(value) {
  return value === 1 || value === "1" || value === true;
}

function buyerLastMile(tpl) {
  if (!isCrossBorderTemplate(tpl)) return 0;
  return num(tpl.buyerLogisticCharge, 0) || 0;
}

function sellerLastMile(tpl) {
  if (!isCrossBorderTemplate(tpl) || !isYes(tpl.hasSellerLogisticCharge)) return 0;
  const n = num(tpl.sellerLogisticCharge);
  if (n != null) return n;
  return buyerLastMile(tpl);
}

/**
 * 藏价只有头程，尾程不进藏价（官方、第三方相同）。
 * officialFreightTpl：头程 = 运费表（站点币→CNY）。
 * 第三方：按首重续重 / 按重量计费 / 统一运费。
 * 交易手续费仍按 (P + 尾程) × 支付费率，分子加 尾程×支付费率。
 */
export function calcCrossBorderFreight(tpl, dims = {}, ctx = {}) {
  const lastMileBuyer = buyerLastMile(tpl);
  const lastMileSeller = sellerLastMile(tpl);
  if (isOfficialFreightTpl(tpl)) {
    const parcel = calcParcelFreightCny(ctx.freightTable, tpl.site, dims.wReal, ctx.fxRates);
    return {
      mode: "official",
      freight: parcel.cny,
      firstMile: parcel.cny,
      firstMileLocal: parcel.localAmount,
      firstMileCurrency: parcel.currency,
      lastMile: 0,
      lastMileSeller,
      lastMileBuyer,
      chargeWeight: null,
      volWeight: null,
    };
  }
  const mode = freightModeOf(tpl);
  if (mode === "per_kg") {
    const billed = calcFirstMileByKg(tpl, dims);
    return {
      mode,
      freight: billed.firstMile,
      firstMile: billed.firstMile,
      lastMile: 0,
      lastMileSeller,
      lastMileBuyer,
      chargeWeight: billed.chargeWeight,
      volWeight: billed.volWeight,
      firstMileLocal: null,
      firstMileCurrency: "",
    };
  }
  if (mode === "weight") {
    const billed = calcFirstMileByWeight(tpl, dims);
    return {
      mode,
      freight: billed.firstMile,
      firstMile: billed.firstMile,
      lastMile: 0,
      lastMileSeller,
      lastMileBuyer,
      chargeWeight: billed.chargeWeight,
      volWeight: billed.volWeight,
      firstMileLocal: null,
      firstMileCurrency: "",
    };
  }
  const firstMile = num(tpl.logisticsCharge, 0) || 0;
  return {
    mode: "fixed",
    freight: firstMile,
    firstMile,
    firstMileLocal: null,
    firstMileCurrency: "",
    lastMile: 0,
    lastMileSeller,
    lastMileBuyer,
    chargeWeight: null,
    volWeight: null,
  };
}

/**
 * 增值税 = P / [(1+t)(1+v)] * (1+t) * v
 * 关税   = P / [(1+t)(1+v)] * t
 */
export function calcCrossBorderTax(after, tariffRate, vatRate) {
  const t = Number(tariffRate) || 0;
  const v = Number(vatRate) || 0;
  const k = (1 + t) * (1 + v);
  const base = after / k;
  return { k, taxShare: 1 - 1 / k, tariff: base * t, vat: base * (1 + t) * v };
}

function readRates(tpl) {
  return {
    profitMode: normalizeProfitType(tpl.profitType),
    profitRate: rateFromPercent(tpl.profitPercent),
    profitAmount: num(tpl.profitPercent, 0) || 0,
    platformRate: rateFromPercent(tpl.platformChargePercent),
    payRate: rateFromPercent(tpl.paymentChargePercent),
    withdrawRate: rateFromPercent(tpl.withdrawChargePercent),
    growthRate: rateFromPercent(tpl.growthPercent ?? DEFAULT_LOCAL_PRICE.growthPercent),
    commissionRate: rateFromPercent(tpl.commissionPercent ?? DEFAULT_LOCAL_PRICE.commissionPercent),
    vatRate: rateFromPercent(tpl.vatChargePercent ?? tpl.vatPercent),
    tariffRate: rateFromPercent(tpl.tariffChargePercent ?? tpl.tariffPercent),
    discount: discountRate(tpl.discount),
    otherFee: num(tpl.otherCharge, 0) || 0,
    fixedInfraFee: num(tpl.fixedInfraFee, DEFAULT_LOCAL_PRICE.fixedInfraFee) ?? DEFAULT_LOCAL_PRICE.fixedInfraFee,
  };
}

/**
 * 跨境折后价 P：
 * 平台费率合计 f = 佣金+支付+提现+增长+达人（不含增值税关税）
 * 税负份额 = 1 - 1/[(1+t)(1+v)]
 * 分子 = 采购侧 + 藏价 + 基建 + 其他 + 尾程×支付费率
 * 成本利润率：采购侧 = 采购×(1+利润率)；售价利润率：采购侧 = 采购，且分母再减利润率
 * 交易手续费 = (P + 尾程) × 支付费率
 */
export function calcCrossBorderPrice(tpl, input = {}) {
  const rates = readRates(tpl);
  const freightInfo = calcCrossBorderFreight(tpl, input, {
    freightTable: input.freightTable,
    fxRates: input.fxRates,
  });
  const {
    profitMode, profitRate, profitAmount, platformRate, payRate, withdrawRate,
    growthRate, commissionRate, vatRate, tariffRate, discount, otherFee, fixedInfraFee,
  } = rates;
  const feeSum = platformRate + payRate + withdrawRate + growthRate + commissionRate;
  const tax = calcCrossBorderTax(1, tariffRate, vatRate);
  const sumRate = (profitMode === "sale" ? profitRate : 0) + feeSum + tax.taxShare;
  if (sumRate >= 1) throw new Error(`费率合计 ${(sumRate * 100).toFixed(2)}% 必须小于 100%`);
  const lastMilePay = Number(freightInfo.lastMileBuyer) || 0;
  const extras = freightInfo.freight + fixedInfraFee + otherFee + lastMilePay * payRate;
  let numer = Number(input.cost) + extras;
  if (profitMode === "cost") numer = Number(input.cost) * (1 + profitRate) + extras;
  else if (profitMode === "fixed") numer = Number(input.cost) + profitAmount + extras;
  const after = numer / (1 - sumRate);
  const taxOnAfter = calcCrossBorderTax(after, tariffRate, vatRate);
  const profit = profitMode === "fixed" ? profitAmount : profitMode === "cost" ? Number(input.cost) * profitRate : after * profitRate;
  const fees = {
    freight: round(freightInfo.freight, 2),
    firstMile: round(freightInfo.firstMile, 2),
    firstMileLocal: freightInfo.firstMileLocal == null ? null : round(freightInfo.firstMileLocal, 2),
    firstMileCurrency: freightInfo.firstMileCurrency || "",
    lastMileSeller: round(freightInfo.lastMileSeller || 0, 2),
    lastMileBuyer: round(freightInfo.lastMileBuyer || 0, 2),
    platform: round(after * platformRate, 2),
    payment: round((after + lastMilePay) * payRate, 2),
    withdraw: round(after * withdrawRate, 2),
    commission: round(after * commissionRate, 2),
    infra: round(fixedInfraFee, 2),
    growth: round(after * growthRate, 2),
    vat: round(taxOnAfter.vat, 2),
    tariff: round(taxOnAfter.tariff, 2),
    cost: round(Number(input.cost), 2),
    other: round(otherFee, 2),
  };
  fees.tiktokPlatform = round(fees.platform + fees.payment + fees.withdraw + fees.commission + fees.infra + fees.growth + fees.vat + fees.tariff, 2);
  return {
    kind: "cross_border",
    mode: freightInfo.mode,
    priceOriginal: round(after / discount, 2),
    priceAfterDiscount: round(after, 2),
    profit: round(profit, 2),
    freight: fees.freight,
    chargeWeight: freightInfo.chargeWeight == null ? null : round(freightInfo.chargeWeight, 4),
    volWeight: freightInfo.volWeight == null ? null : round(freightInfo.volWeight, 4),
    fees,
    rates: { profitRate, platformRate, payRate, withdrawRate, growthRate, commissionRate, vatRate, tariffRate, discount, otherFee, fixedInfraFee, sumRate },
  };
}
