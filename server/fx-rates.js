export const FX_ROWS = [
  { site: "TH", currency: "THB", name: "泰国" },
  { site: "MY", currency: "MYR", name: "马来西亚" },
  { site: "PH", currency: "PHP", name: "菲律宾" },
  { site: "VN", currency: "VND", name: "越南" },
  { site: "SG", currency: "SGD", name: "新加坡" },
  { site: "ID", currency: "IDR", name: "印尼" },
  { site: "US", currency: "USD", name: "美国" },
  { site: "GB", currency: "GBP", name: "英国" },
];

export const DEFAULT_FX_RATES = {
  THB: 4.9,
  MYR: 0.61,
  PHP: 8.1,
  VND: 3500,
  SGD: 0.18,
  IDR: 2200,
  USD: 0.14,
  GBP: 0.11,
};

export function normalizeFxRates(raw = {}) {
  const next = { ...DEFAULT_FX_RATES };
  for (const row of FX_ROWS) {
    const n = Number(raw[row.currency]);
    if (Number.isFinite(n) && n > 0) next[row.currency] = n;
  }
  return next;
}

export function currencyOfSite(site) {
  return FX_ROWS.find((row) => row.site === site)?.currency || "THB";
}
