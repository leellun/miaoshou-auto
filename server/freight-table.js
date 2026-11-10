import { FX_ROWS, currencyOfSite } from "./fx-rates.js";

export const FREIGHT_ROWS = FX_ROWS.map((row) => ({
  site: row.site,
  name: row.name,
  currency: row.currency,
}));

const EMPTY_ROW = {
  startWeight: "",
  liftPrice: "",
  continuePrice10g: "",
  buyerPayFreight: "",
};

function numOrBlank(value) {
  if (value === "" || value == null) return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

export function emptyFreightTable() {
  const table = {};
  for (const row of FREIGHT_ROWS) table[row.site] = { ...EMPTY_ROW };
  return table;
}

export function normalizeFreightTable(raw = {}) {
  const next = emptyFreightTable();
  for (const row of FREIGHT_ROWS) {
    const item = raw[row.site] || {};
    next[row.site] = {
      startWeight: numOrBlank(item.startWeight),
      liftPrice: numOrBlank(item.liftPrice),
      continuePrice10g: numOrBlank(item.continuePrice10g),
      buyerPayFreight: numOrBlank(item.buyerPayFreight),
    };
  }
  return next;
}

/** 站点币：起始重量为 g。≤起始重量收起重价，超出按每 10g 向上取整 × 续重价。 */
export function calcParcelFreightLocal(row, weightKg) {
  const wKg = Number(weightKg);
  const startG = Number(row?.startWeight);
  const lift = Number(row?.liftPrice);
  const per10g = Number(row?.continuePrice10g);
  if (!Number.isFinite(wKg)) throw new Error("跨境物流需要重量");
  if (!Number.isFinite(startG) || !Number.isFinite(lift)) {
    throw new Error("请先在跨境运费设置里填写该国家的起始重量和起重价格");
  }
  const wG = wKg * 1000;
  if (wG <= startG) return lift;
  const extra10g = Math.ceil((wG - startG) / 10 - 1e-12);
  return lift + extra10g * (Number.isFinite(per10g) ? per10g : 0);
}

/** 站点币 → 人民币。汇率为 1 CNY ≈ 站点币；已是 CNY 则不换。 */
export function parcelFreightToCny(localAmount, currency, fxRates) {
  const amount = Number(localAmount);
  if (!Number.isFinite(amount)) return 0;
  if (!currency || currency === "CNY") return amount;
  const rate = Number(fxRates?.[currency]);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`缺少 ${currency} 汇率，请先在汇率设置里填写`);
  }
  return amount / rate;
}

export function calcParcelFreightCny(table, site, weightKg, fxRates) {
  const row = (table || {})[site] || {};
  const currency = currencyOfSite(site);
  const localAmount = calcParcelFreightLocal(row, weightKg);
  return {
    localAmount,
    currency,
    cny: parcelFreightToCny(localAmount, currency, fxRates),
  };
}
