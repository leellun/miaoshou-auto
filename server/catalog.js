export function parseLinks(text) {
  const lines = String(text || "")
    .split(/[\n,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const seen = new Set();
  const urls = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    urls.push(line);
  }
  return urls;
}

export function extractSourceId(url) {
  const text = String(url || "");
  try {
    const parsed = new URL(text);
    const offerId = parsed.searchParams.get("offerId") || parsed.searchParams.get("offerid");
    if (offerId && /^\d{6,}$/.test(offerId)) return offerId;
  } catch {
    // 非标准 URL 时走下面的路径匹配
  }
  const offerPath = text.match(/offer\/(\d{6,})/i);
  if (offerPath) return offerPath[1];
  const id = text.match(/(\d{8,})/);
  return id ? id[1] : "";
}

export function sourceFromUrl(url) {
  if (/1688\.com/i.test(url)) return "1688";
  if (/taobao|tmall/i.test(url)) return "淘宝";
  if (/pinduoduo|yangkeduo/i.test(url)) return "拼多多";
  return "";
}
