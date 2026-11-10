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
