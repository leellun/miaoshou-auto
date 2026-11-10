import { useEffect, useState } from "react";
import { api } from "./api";
import PricingSetup from "./PricingSetup.jsx";
import FxRates from "./FxRates.jsx";
import FreightTable from "./FreightTable.jsx";

const NAV = [
  { group: "工作台", items: [
    { id: "dashboard", title: "自动化总览", icon: "◫" },
    { id: "collect", title: "产品采集", icon: "＋" },
    { id: "common", title: "公共采集箱", icon: "▣" },
    { id: "tiktok", title: "TK采集箱", icon: "⌁" },
    { id: "tiktok-pro", title: "TK采集箱Pro", icon: "⚡" },
  ]},
  { group: "配置", items: [
    { id: "pricing", title: "定价模板", icon: "￥" },
    { id: "fx", title: "汇率设置", icon: "⇄" },
    { id: "freight", title: "跨境运费", icon: "📦" },
    { id: "shops", title: "店铺与站点", icon: "⌘" },
    { id: "settings", title: "系统设置", icon: "⚙" },
  ]},
];

const SITE_OPTIONS = {
  tiktok: [["TH", "泰国 TH"], ["MY", "马来西亚 MY"], ["PH", "菲律宾 PH"]],
  shopee: [["TH", "泰国 TH"], ["MY", "马来西亚 MY"], ["PH", "菲律宾 PH"]],
  ozon: [["OZON", "Ozon"]],
};

const EMPTY_OVERVIEW = {
  stats: { collected: 0, processed: 0, published: 0, exceptions: 0, pipeline: [0, 0, 0, 0, 0, 0], collectDelta: 0 },
  tasks: [],
  exceptions: [],
  settings: { mode: "live", apiStatus: "", lastSyncAt: "—" },
};

function Switch({ on, onClick, label }) {
  return <button className={`switch ${on ? "on" : ""}`} aria-label={label} onClick={onClick} type="button" />;
}

function Status({ status, text }) {
  const cls = status === "running" || status === "queued" ? "s-run" : status === "success" || status === "pass" || status === "published" || status === "authorized" ? "s-ok" : "s-fail";
  return <span className={`status ${cls}`}>{text}</span>;
}

function taskStatus(task) {
  if (task.status === "running" || task.status === "queued") return `加工中 ${task.progress}%`;
  if (task.status === "success") return `成功 ${task.ok}${task.fail ? ` / 异常 ${task.fail}` : ""}`;
  return `异常 ${task.fail || 0}`;
}

function Cover({ src, fallback = "⌁" }) {
  return (
    <div className="product-img">
      {src ? <img src={src} alt="封面" referrerPolicy="no-referrer" /> : fallback}
    </div>
  );
}

function fmtPct(value) {
  return value == null || value === "" ? "—" : `${value}%`;
}

function logisticsTypeLabel(type, cross) {
  if (type === "official_freight_tpl" || type === "officialFreightTpl") return "官方跨境物流";
  const third = cross ? "第三方 · " : "";
  if (type === "first_continued") return `${third}首重续重`;
  if (type === "byWeightAndFixedCharge" || type === "weight_interval") return `${third}按重量计费`;
  if (type === "fixed") return `${third}统一运费`;
  return type || "—";
}

function logisticsSummary(item) {
  const type = item.logisticsComputeType;
  const cross = item.siteType === "cross_border";
  if (type === "official_freight_tpl" || type === "officialFreightTpl") return "官方跨境物流";
  const third = cross ? "第三方 · " : "";
  if (type === "first_continued") {
    const first = [item.firstWeightCharge != null ? `${item.firstWeightCharge}元` : "", item.firstWeightInterval != null ? `/${item.firstWeightInterval}kg` : ""].join("");
    const light = item.isCalLightCargo === 1 || item.isCalLightCargo === "1" ? " · 抛重" : "";
    return `${third}首重续重${first ? ` · 首重 ${first}` : ""}${light}`;
  }
  if (type === "byWeightAndFixedCharge" || type === "weight_interval") {
    const rate = item.firstWeightCharge;
    const fixed = item.continuedWeightCharge;
    const bits = [rate != null && rate !== "" ? `${rate}元/kg` : "", fixed != null && fixed !== "" ? `固定 ${fixed}` : ""].filter(Boolean).join(" · ");
    return `${third}按重量计费${bits ? ` · ${bits}` : ""}`;
  }
  if (type === "fixed") return `${third}统一运费 ${item.logisticsCharge ?? "—"}`;
  return logisticsTypeLabel(type, cross);
}

function logLevelText(level) {
  if (level === "error") return "错误";
  if (level === "warn") return "警告";
  return "信息";
}

function shopPlatformOf(shop) {
  return String(shop?.platform || shop?.platformName || "").trim().toLowerCase();
}

function samePlatformShop(list, shop) {
  const platform = shopPlatformOf(shop);
  if (!platform) return null;
  return (list || []).find((item) => String(item.id) !== String(shop.id) && shopPlatformOf(item) === platform) || null;
}

export default function App() {
  const [view, setView] = useState("dashboard");
  const [toast, setToast] = useState("");
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [shops, setShops] = useState([]);
  const [pricing, setPricing] = useState([]);
  const [priceTemplates, setPriceTemplates] = useState([]);
  const [shopPriceTemplates, setShopPriceTemplates] = useState([]);
  const [priceSiteType, setPriceSiteType] = useState("");
  const [priceQuery, setPriceQuery] = useState("");
  const [priceLoading, setPriceLoading] = useState(false);
  const [priceSetupItem, setPriceSetupItem] = useState(null);
  const [settings, setSettings] = useState(null);
  const [common, setCommon] = useState({ items: [], counts: {} });
  const [tiktok, setTiktok] = useState({ items: [], counts: {} });
  const [commonTab, setCommonTab] = useState("unclaimed");
  const [tkTab, setTkTab] = useState("unpublished");
  const [commonQ, setCommonQ] = useState("");
  const [commonSelected, setCommonSelected] = useState([]);
  const [commonBusy, setCommonBusy] = useState(false);
  const [tkSelected, setTkSelected] = useState([]);
  const [tkBusy, setTkBusy] = useState(false);
  const [tiktokPro, setTiktokPro] = useState({ items: [], counts: {} });
  const [tkProTab, setTkProTab] = useState("unpublished");
  const [tkProQ, setTkProQ] = useState("");
  const [tkProSite, setTkProSite] = useState("TH");
  const [tkProSelected, setTkProSelected] = useState([]);
  const [tkProBusy, setTkProBusy] = useState(false);
  const [claimPendingIds, setClaimPendingIds] = useState(null);
  const [deletePendingIds, setDeletePendingIds] = useState(null);
  const [deletePendingBox, setDeletePendingBox] = useState("common");
  const [tkQ, setTkQ] = useState("");
  const [tkSite, setTkSite] = useState("TH");
  const [links, setLinks] = useState("");
  const [selectedShops, setSelectedShops] = useState([]);
  const [selectedShopMap, setSelectedShopMap] = useState({});
  const [draftSelected, setDraftSelected] = useState({});
  const [autoPublish, setAutoPublish] = useState(false);
  const [publishWhen, setPublishWhen] = useState("manual");
  const [aiTitle, setAiTitle] = useState(true);
  const [autoCategory, setAutoCategory] = useState(true);
  const [claimPerPlatform, setClaimPerPlatform] = useState(true);
  const [picker, setPicker] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [pickerPlatform, setPickerPlatform] = useState("tiktok");
  const [pickerSite, setPickerSite] = useState("TH");
  const [shopSearch, setShopSearch] = useState("");
  const [pickerShops, setPickerShops] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [activeTask, setActiveTask] = useState(null);
  const [exceptionsOpen, setExceptionsOpen] = useState(false);
  const [assignPendingIds, setAssignPendingIds] = useState(null);
  const [bootError, setBootError] = useState("");

  const crumb = view === "pricing-setup" ? "定价模板设置" : (NAV.flatMap((g) => g.items).find((x) => x.id === view)?.title || "自动化总览");
  const chosenShops = selectedShops.map((id) => shops.find((s) => String(s.id) === String(id)) || selectedShopMap[id]).filter(Boolean);
  const draftList = Object.values(draftSelected);
  const linkCount = links.split(/\n/).map((x) => x.trim()).filter(Boolean).length;
  const boundPricingCount = chosenShops.filter((s) => s.pricingId).length;

  function shopPayload(shop) {
    return {
      id: shop.id,
      name: shop.name,
      platform: shop.platform,
      platformName: shop.platformName,
      site: shop.site,
      type: shop.type,
      isCb: shop.isCb,
      isCnsc: shop.isCnsc,
      pricingId: shop.pricingId,
    };
  }

  function notify(text) {
    setToast(text);
    setTimeout(() => setToast(""), 2400);
  }

  async function refreshAll() {
    const [ov, price, st] = await Promise.all([
      api("/api/overview"),
      api("/api/pricing"),
      api("/api/settings"),
    ]);
    setOverview(ov);
    setPricing(price.items || []);
    setSettings(st);
    try {
      const shopData = await api("/api/shops?platform=tiktok");
      setShops(shopData.items || []);
    } catch {
      // 店铺列表失败不挡首页
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const [ov, price, st] = await Promise.all([
          api("/api/overview"),
          api("/api/pricing"),
          api("/api/settings"),
        ]);
        setOverview(ov || EMPTY_OVERVIEW);
        setPricing(price.items || []);
        setSettings(st);
        setBootError("");
        const shopData = await api("/api/shops?platform=tiktok").catch(() => ({ items: [] }));
        setShops(shopData.items || []);
      } catch (error) {
        setBootError(error.message || "无法连接自动化服务");
      }
    })();
  }, []);

  async function loadCommon() {
    const data = await api(`/api/common?tab=${commonTab}&q=${encodeURIComponent(commonQ)}`);
    setCommon(data);
    const visible = new Set((data.items || []).map((x) => x.id));
    setCommonSelected((prev) => prev.filter((id) => visible.has(id)));
  }
  async function loadTiktok() {
    const data = await api(`/api/tiktok?tab=${tkTab}&site=${tkSite}&q=${encodeURIComponent(tkQ)}`);
    setTiktok(data);
    const visible = new Set((data.items || []).map((x) => x.id));
    setTkSelected((prev) => prev.filter((id) => visible.has(id)));
  }
  async function loadTiktokPro() {
    const data = await api(`/api/tiktok?tab=${tkProTab}&site=${tkProSite}&q=${encodeURIComponent(tkProQ)}`);
    setTiktokPro(data);
    const visible = new Set((data.items || []).map((x) => x.id));
    setTkProSelected((prev) => prev.filter((id) => visible.has(id)));
  }

  const commonIds = common.items.map((x) => x.id);
  const commonAllChecked = commonIds.length > 0 && commonIds.every((id) => commonSelected.includes(id));

  function toggleCommonSelected(id, checked) {
    setCommonSelected((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  }

  function toggleAllCommon(checked) {
    setCommonSelected(checked ? common.items.map((x) => x.id) : []);
  }

  async function deleteCommonItems(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) {
      notify("请先勾选要删除的商品");
      return;
    }
    setCommonBusy(true);
    try {
      await api("/api/common/delete", { method: "POST", body: { ids: list } });
      setCommonSelected((prev) => prev.filter((id) => !list.includes(id)));
      await loadCommon();
      notify(`已删除 ${list.length} 个商品`);
    } finally {
      setCommonBusy(false);
    }
  }

  const tkIds = tiktok.items.map((x) => x.id);
  const tkAllChecked = tkIds.length > 0 && tkIds.every((id) => tkSelected.includes(id));

  function toggleTkSelected(id, checked) {
    setTkSelected((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  }

  function toggleAllTk(checked) {
    setTkSelected(checked ? tiktok.items.map((x) => x.id) : []);
  }

  const tkProIds = tiktokPro.items.map((x) => x.id);
  const tkProAllChecked = tkProIds.length > 0 && tkProIds.every((id) => tkProSelected.includes(id));

  function toggleTkProSelected(id, checked) {
    setTkProSelected((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  }

  function toggleAllTkPro(checked) {
    setTkProSelected(checked ? tiktokPro.items.map((x) => x.id) : []);
  }

  async function deleteTiktokItems(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) {
      notify("请先勾选要删除的商品");
      return;
    }
    setTkBusy(true);
    try {
      await api("/api/tiktok/delete", { method: "POST", body: { ids: list } });
      setTkSelected((prev) => prev.filter((id) => !list.includes(id)));
      await loadTiktok();
      notify(`已删除 ${list.length} 个商品`);
    } finally {
      setTkBusy(false);
    }
  }

  async function deleteTiktokProItems(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) {
      notify("请先勾选要删除的商品");
      return;
    }
    setTkProBusy(true);
    try {
      await api("/api/tiktok/delete", { method: "POST", body: { ids: list } });
      setTkProSelected((prev) => prev.filter((id) => !list.includes(id)));
      await loadTiktokPro();
      notify(`已删除 ${list.length} 个商品`);
    } finally {
      setTkProBusy(false);
    }
  }

  function askDelete(ids, box = "common") {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) {
      notify("请先勾选要删除的商品");
      return;
    }
    setDeletePendingBox(box);
    setDeletePendingIds(list);
  }

  async function confirmDelete() {
    const list = deletePendingIds || [];
    const box = deletePendingBox;
    setDeletePendingIds(null);
    if (!list.length) return;
    if (box === "tiktok") await deleteTiktokItems(list);
    else if (box === "tiktok-pro") await deleteTiktokProItems(list);
    else await deleteCommonItems(list);
  }

  async function claimCommonItems(ids, shopOverride) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) {
      notify("请先勾选要认领的商品");
      return;
    }
    const shopsToUse = shopOverride?.length ? shopOverride : chosenShops;
    if (!shopsToUse.length) {
      notify("请先选择要认领到的店铺");
      return;
    }
    const unclaimed = common.items.filter((item) => list.includes(item.id) && !item.claimed).map((item) => item.id);
    const useIds = unclaimed.length ? unclaimed : list;
    const task = await api("/api/common/claim", {
      method: "POST",
      body: {
        ids: useIds,
        shopIds: shopsToUse.map((shop) => shop.id),
        shops: shopsToUse.map(shopPayload),
        autoPublish: publishWhen === "now",
        schedule: publishWhen,
        aiTitle,
      },
    });
    setCommonSelected((prev) => prev.filter((id) => !useIds.includes(id)));
    setActiveTask(task);
    setDrawer(true);
    notify("已从平台认领开始处理");
  }

  function startClaim(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) {
      notify("请先勾选要认领的商品");
      return;
    }
    setAssignPendingIds(null);
    setClaimPendingIds(list);
    openShopPicker("claim");
  }

  function startAssignShops(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) {
      notify("请先勾选要设置店铺的商品");
      return;
    }
    setClaimPendingIds(null);
    setAssignPendingIds(list);
    openShopPicker("assign");
  }

  useEffect(() => { if (view === "common") loadCommon(); }, [view, commonTab, commonQ]);
  useEffect(() => { setCommonSelected([]); }, [commonTab]);
  useEffect(() => { if (view === "tiktok") loadTiktok(); }, [view, tkTab, tkQ, tkSite]);
  useEffect(() => { setTkSelected([]); }, [tkTab]);
  useEffect(() => { if (view === "tiktok-pro") loadTiktokPro(); }, [view, tkProTab, tkProQ, tkProSite]);
  useEffect(() => { setTkProSelected([]); }, [tkProTab]);
  useEffect(() => {
    setSelectedShopMap((prev) => {
      const next = { ...prev };
      for (const shop of shops) {
        if (selectedShops.includes(shop.id)) next[shop.id] = shop;
      }
      return next;
    });
  }, [shops, selectedShops]);

  useEffect(() => {
    if (!picker) return;
    const timer = setTimeout(async () => {
      setPickerLoading(true);
      setPickerError("");
      setPickerShops([]);
      try {
        const data = await api(`/api/shops?platform=${pickerPlatform}&site=${pickerSite}&q=${encodeURIComponent(shopSearch)}`);
        setPickerShops(data.items || []);
        setShops((prev) => {
          const ids = new Set(prev.map((x) => x.id));
          return [...prev, ...(data.items || []).filter((x) => !ids.has(x.id))];
        });
      } catch (error) {
        setPickerError(error.message);
      } finally {
        setPickerLoading(false);
      }
    }, shopSearch ? 280 : 0);
    return () => clearTimeout(timer);
  }, [picker, pickerPlatform, pickerSite, shopSearch]);

  useEffect(() => {
    if (view !== "pricing") return;
    const timer = setTimeout(async () => {
      setPriceLoading(true);
      try {
        const query = new URLSearchParams({ site: "", siteType: priceSiteType, name: priceQuery });
        const data = await api(`/api/price-templates?${query}`);
        setPriceTemplates(data.items || []);
      } catch (error) {
        notify(error.message);
      } finally {
        setPriceLoading(false);
      }
    }, priceQuery ? 280 : 0);
    return () => clearTimeout(timer);
  }, [view, priceSiteType, priceQuery]);

  useEffect(() => {
    if (view !== "shops") return;
    api("/api/price-templates?site=&siteType=").then((data) => {
      setShopPriceTemplates(data.items || []);
    }).catch((error) => notify(error.message));
  }, [view]);

  useEffect(() => {
    if (!drawer || !activeTask?.id) return;
    const startedRunning = activeTask.status === "running" || activeTask.status === "queued";
    let notified = false;
    let fails = 0;
    const timer = setInterval(async () => {
      try {
        const task = await api(`/api/tasks/${activeTask.id}`);
        fails = 0;
        setActiveTask(task);
        const ended = (task.logs || []).some((line) => String(line.message).startsWith("任务结束")) || task.status === "failed";
        if (startedRunning && !notified && (task.status === "success" || task.status === "failed") && ended) {
          notified = true;
          const optimize = task.kind === "optimize";
          const claim = task.kind === "claim";
          notify(task.status === "success"
            ? (optimize ? "AI 优化完成，可在日志里核对每一步" : claim ? "认领加工完成，可在日志里核对每一步" : "采集完成，可在日志里核对每一步")
            : `${optimize ? "AI 优化" : claim ? "认领" : "采集"}出问题了：${task.error || "请看下方日志"}`);
          await refreshAll();
          await loadCommon();
          await loadTiktok();
          if (view === "tiktok-pro") await loadTiktokPro();
        }
      } catch (error) {
        fails += 1;
        if (fails >= 3) {
          clearInterval(timer);
          notify(error.message || "自动化服务连不上，请看终端");
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [drawer, activeTask?.id]);

  function setPublishMode(value) {
    setPublishWhen(value);
    setAutoPublish(value === "now");
  }

  async function startTask(sourceLinks) {
    const task = await api("/api/tasks", {
      method: "POST",
      body: {
        linksText: sourceLinks,
        shopIds: selectedShops,
        shops: chosenShops.map(shopPayload),
        autoPublish: publishWhen === "now",
        schedule: publishWhen,
        aiTitle,
        autoCategory,
        claimPerPlatform,
      },
    });
    setActiveTask(task);
    setDrawer(true);
  }

  async function startOptimize(ids) {
    const task = await api("/api/tiktok/optimize", { method: "POST", body: { ids } });
    setActiveTask(task);
    setDrawer(true);
  }

  async function startOptimizePro(ids) {
    const task = await api("/api/tiktok-pro/optimize", { method: "POST", body: { ids } });
    setActiveTask(task);
    setDrawer(true);
  }

  async function openTaskLogs(taskId) {
    const task = await api(`/api/tasks/${taskId}`);
    setActiveTask(task);
    setDrawer(true);
  }

  function openShopPicker(purpose = "collect") {
    if (purpose === "collect") {
      setClaimPendingIds(null);
      setAssignPendingIds(null);
    }
    if (purpose === "assign") {
      setPickerPlatform("tiktok");
      setPickerSite((site) => (SITE_OPTIONS.tiktok.some(([v]) => v === site) ? site : "TH"));
    }
    const map = {};
    if (purpose !== "assign") {
      for (const id of selectedShops) {
        map[id] = selectedShopMap[id] || shops.find((s) => s.id === id) || { id, name: id, platformName: "", site: "", type: "" };
      }
    }
    setDraftSelected(map);
    setShopSearch("");
    setPickerError("");
    setPicker(true);
  }

  function toggleDraftShop(shop, checked) {
    if (checked) {
      const existing = samePlatformShop(Object.values(draftSelected), shop);
      if (existing) {
        notify(`${existing.platformName || existing.platform} 已选择「${existing.name}」，同一平台不能再选其他店铺`);
        return;
      }
    }
    setDraftSelected((prev) => {
      const next = { ...prev };
      if (checked) next[shop.id] = shop;
      else delete next[shop.id];
      return next;
    });
  }

  function closeShopPicker() {
    setPicker(false);
    setClaimPendingIds(null);
    setAssignPendingIds(null);
  }

  function confirmShopPicker() {
    const ids = Object.keys(draftSelected);
    const pendingClaim = claimPendingIds;
    const pendingAssign = assignPendingIds;
    const shopsToUse = Object.values(draftSelected);
    const duplicate = shopsToUse.find((shop, index) => samePlatformShop(shopsToUse.slice(0, index), shop));
    if (duplicate) {
      notify(`${duplicate.platformName || duplicate.platform} 已有店铺，同一平台只能选择一个`);
      return;
    }
    setSelectedShops(ids);
    setSelectedShopMap(draftSelected);
    setPicker(false);
    setClaimPendingIds(null);
    setAssignPendingIds(null);
    if (pendingClaim?.length) {
      if (!shopsToUse.length) {
        notify("请先选择要认领到的店铺");
        return;
      }
      claimCommonItems(pendingClaim, shopsToUse).catch((e) => notify(e.message));
      return;
    }
    if (pendingAssign?.length) {
      const tiktokShops = shopsToUse.filter((shop) => String(shop.platform || "tiktok").toLowerCase() === "tiktok");
      if (!tiktokShops.length) {
        notify("请先选择 TikTok 店铺");
        return;
      }
      setTkBusy(true);
      if (view === "tiktok-pro") setTkProBusy(true);
      api("/api/tiktok/assign-shop", {
        method: "POST",
        body: {
          ids: pendingAssign,
          shopIds: tiktokShops.map((shop) => shop.id),
          shops: tiktokShops,
        },
      }).then(() => {
        if (view === "tiktok-pro") loadTiktokPro();
        else loadTiktok();
        notify(`已认领到 ${tiktokShops.length} 个店铺`);
      }).catch((e) => notify(e.message)).finally(() => {
        setTkBusy(false);
        setTkProBusy(false);
      });
    }
  }

  const exceptionCount = overview?.exceptions?.length || 0;

  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><div className="logo">M</div><span>妙手自动上架</span></div>
        {NAV.map((group) => (
          <div key={group.group}>
            <div className="nav-title">{group.group}</div>
            <nav className="nav">
              {group.items.map((item) => (
                <button key={item.id} className={view === item.id || (item.id === "pricing" && view === "pricing-setup") ? "active" : ""} onClick={() => { setView(item.id); if (item.id === "pricing") setPriceSetupItem(null); }}>
                  <i>{item.icon}</i><span>{item.title}</span>
                </button>
              ))}
            </nav>
          </div>
        ))}
        <div className="account"><div className="avatar">陈</div><div><b style={{ color: "#fff" }}>管理员</b><br /><small>运营团队</small></div></div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb">{view === "pricing-setup" ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <button className="btn" type="button" onClick={() => { setView("pricing"); setPriceSetupItem(null); }}>← 返回</button>
              {crumb}
            </span>
          ) : crumb}</div>
          <div className="top-actions">
            <button className="btn" onClick={() => { setView("dashboard"); setExceptionsOpen(true); }}>查看异常 {exceptionCount}</button>
            <button className="btn primary" onClick={() => { setView("collect"); setActiveTask(null); }}>＋ 新建全自动任务</button>
          </div>
        </header>

        {bootError && (
          <div className="content" style={{ paddingBottom: 0 }}>
            <div className="callout">{bootError}（页面仍可使用，数据可能未同步）</div>
          </div>
        )}
        {view === "dashboard" && (
          <div className="content">
            <div className="heading">
              <div><h1>今天的上架工作</h1><p>系统正在自动采集、加工并发布商品，只有异常任务需要你处理。</p></div>
              <div className="health"><span className={`dot ${overview.settings?.apiStatus === "error" ? "warn" : ""}`}></span>{overview.settings?.mode === "live" ? "妙手 API" : "未接接口"} · 最近同步 {overview.settings?.lastSyncAt || "—"}</div>
            </div>
            <section className="stats">
              <div className="card stat"><div className="label">今日采集</div><strong>{overview.stats?.collected ?? 0}</strong><span className="delta">↑ {overview.stats?.collectDelta ?? 0}% 较昨日</span></div>
              <div className="card stat"><div className="label">自动加工完成</div><strong>{overview.stats?.processed ?? 0}</strong><span className="delta">84.3% 自动通过</span></div>
              <div className="card stat"><div className="label">上架成功</div><strong>{overview.stats?.published ?? 0}</strong><span className="delta">TikTok 多店铺</span></div>
              <div className="card stat"><div className="label">待处理异常</div><strong>{overview.stats?.exceptions ?? 0}</strong><span className="delta warn">需人工处理</span></div>
            </section>
            <div className="workspace">
              <section className="card panel">
                <div className="panel-head"><h2>实时自动化流水线</h2><div className="tabs"><button className="active">今天</button><button>近 7 天</button></div></div>
                <div className="pipeline">
                  {["链接采集","数据清洗","AI 加工","规则校验","提交发布","上架成功"].map((label, i) => (
                    <div className="stage live" key={label}><b>{overview.stats?.pipeline?.[i] ?? 0}</b>{label}</div>
                  ))}
                </div>
                <div className="panel-head"><h2>最近任务</h2><span className="meta">点任务可看采集日志</span></div>
                <div className="task-list">
                  {(overview.tasks || []).map((task) => (
                    <button type="button" className="task task-btn" key={task.id} onClick={() => openTaskLogs(task.id).catch((e) => notify(e.message))}>
                      <div className="thumb">{task.emoji}</div>
                      <div><div className="task-title">{task.title}</div><div className="meta">{task.meta} · 点开看日志</div></div>
                      <Status status={task.status} text={taskStatus(task)} />
                    </button>
                  ))}
                </div>
                {exceptionsOpen && (
                  <div style={{ marginTop: 18 }}>
                    <div className="panel-head"><h2>异常列表</h2></div>
                    <div className="exception-list">
                      {overview.exceptions?.map((item) => (
                        <div className="exception-item" key={item.id}><b>{item.type}</b><div className="meta">{item.product} · {item.title}</div></div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
              <aside className="card panel">
                <div className="panel-head"><h2>默认自动化策略</h2></div>
                <div className="form">
                  <div className="field"><label>目标平台与站点</label><div className="grid2"><select defaultValue="tiktok"><option value="tiktok">TikTok Shop</option></select><select defaultValue="TH"><option>泰国 TH</option><option>马来西亚 MY</option></select></div></div>
                  <div className="field"><label>目标店铺</label><select><option>{shops.filter(s=>s.platform==="tiktok").length} 个启用店铺</option></select></div>
                  <div>
                    <div className="switchrow"><span>AI 翻译与标题优化</span><Switch on={aiTitle} onClick={() => setAiTitle(!aiTitle)} /></div>
                    <div className="switchrow"><span>自动类目与属性匹配</span><Switch on={autoCategory} onClick={() => setAutoCategory(!autoCategory)} /></div>
                    <div className="switchrow"><span>图片清洗与尺寸处理</span><Switch on /></div>
                    <div className="switchrow"><span>校验通过后自动发布</span><Switch on={autoPublish} onClick={() => setPublishMode(autoPublish ? "manual" : "now")} /></div>
                  </div>
                  <div className="callout">安全策略：出现侵权词、缺少必填属性或毛利低于 {settings?.minMargin || 15}% 时，系统自动暂停该商品，其他商品继续发布。</div>
                </div>
              </aside>
            </div>
          </div>
        )}

        {view === "collect" && (
          <div className="content">
            <div className="heading"><div><h1>产品采集</h1><p>粘贴货源链接并设置发布目标；提交后商品进入公共采集箱，按条件自动流转。</p></div><div className="health"><span className="dot"></span>自动化服务运行正常</div></div>
            <div className="collector-grid">
              <section className="card form-card">
                <div className="section-title">1. 货源商品</div>
                <div className="field"><label>商品链接</label><textarea className="links-box" value={links} onChange={(e) => setLinks(e.target.value)} /><div className="hint">已识别 {linkCount} 个链接 · 系统会自动去重</div></div>
                <div className="section-title" style={{ marginTop: 24 }}>2. 最终店铺</div>
                <div className="shop-target">
                  <div>
                    <b>已选择 {chosenShops.length} 个平台店铺</b>
                    <div className="shop-tags">{chosenShops.map((s) => <span className="shop-tag" key={s.id}>{s.platformName} · {s.site} · {s.name}</span>)}</div>
                  </div>
                  <button className="btn" onClick={openShopPicker}>选择平台店铺</button>
                </div>
                <div className="section-title" style={{ marginTop: 24 }}>3. 自动化条件</div>
                <div className="option-box">
                  <div className="switchrow"><div><b>自动上架</b><div className="meta">采集并校验通过后直接发布到所选店铺</div></div><Switch on={autoPublish} onClick={() => setPublishMode(autoPublish ? "manual" : "now")} /></div>
                  <div className="switchrow"><div><b>AI标题与翻译</b><div className="meta">按目标站点语言生成标题和描述</div></div><Switch on={aiTitle} onClick={() => setAiTitle(!aiTitle)} /></div>
                  <div className="switchrow"><div><b>自动匹配类目属性</b><div className="meta">匹配TikTok类目并补齐必填属性</div></div><Switch on={autoCategory} onClick={() => setAutoCategory(!autoCategory)} /></div>
                  <div className="switchrow"><div><b>多平台多次认领</b><div className="meta">TikTok、虾皮等各调一次 claimed。同一平台多个店铺也会各调一次 claimed，不重复采集链接。</div></div><Switch on={claimPerPlatform} onClick={() => setClaimPerPlatform(!claimPerPlatform)} /></div>
                </div>
                <div className="field" style={{ marginTop: 14 }}><label>发布时间</label>
                    <select value={publishWhen} onChange={(e) => setPublishMode(e.target.value)}>
                      <option value="now">处理完成后立即发布</option>
                      <option value="manual">处理完成后手动发布</option>
                      <option value="tonight">今晚 20:00</option>
                    </select>
                    {publishWhen === "manual" && <div className="hint">采集和认领照常进行，发布先不做，商品留在 TK 采集箱待你手动点发布</div>}
                </div>
                <div className="field" style={{ marginTop: 14 }}><label>异常处理</label>
                    <select value={settings?.skipOnError ? "skip" : "stop"} onChange={async (e) => {
                      const next = { ...settings, skipOnError: e.target.value === "skip" };
                      setSettings(await api("/api/settings", { method: "POST", body: { skipOnError: next.skipOnError } }));
                    }}>
                      <option value="skip">跳过异常，其他继续</option>
                      <option value="stop">整批暂停</option>
                    </select>
                </div>
              </section>
              <aside className="card form-card">
                <div className="section-title">本次采集确认</div>
                <div className="summary-list">
                  <div className="summary-item"><span>商品链接</span><b>{linkCount} 个</b></div>
                  <div className="summary-item"><span>最终店铺</span><b>{chosenShops.length} 个</b></div>
                  <div className="summary-item"><span>覆盖平台</span><b>{new Set(chosenShops.map((s) => s.platform)).size} 个</b></div>
                  <div className="summary-item"><span>多平台认领</span><b>{claimPerPlatform ? "分别认领" : "共用一条"}</b></div>
                  <div className="summary-item"><span>定价模板</span><b>{chosenShops.length ? `${boundPricingCount}/${chosenShops.length} 店铺已绑定` : "按店铺绑定"}</b></div>
                </div>
                {publishWhen === "now" ? (
                  <div className="auto-mark"><span>✓</span><div><b>全自动上架已开启</b><small>采集 → 公共采集箱 → TK采集箱 → 校验 → 发布</small></div></div>
                ) : publishWhen === "tonight" ? (
                  <div className="callout" style={{ marginTop: 14 }}>处理完成后定时发布，今晚 20:00 再提交店铺。</div>
                ) : <div className="callout" style={{ marginTop: 14 }}>处理完成后手动发布：先采集认领，暂不发布。</div>}
                <div className="callout">如果缺少必填属性、命中风险词或预计毛利低于{settings?.minMargin || 15}%，该商品将暂停并进入异常列表，不影响其他商品。</div>
                <button className="btn green wide" style={{ marginTop: 16, padding: 12 }} onClick={() => startTask(links).catch((e) => notify(e.message))}>开始采集并自动上架</button>
                <div className="section-title" style={{ marginTop: 22 }}>最近采集日志</div>
                <div className="task-list">
                  {(overview.tasks || []).slice(0, 6).map((task) => (
                    <button type="button" className="task task-btn" key={task.id} onClick={() => openTaskLogs(task.id).catch((e) => notify(e.message))}>
                      <div className="thumb">{task.emoji}</div>
                      <div><div className="task-title">{task.title}</div><div className="meta">{task.createdAt} · {task.meta}</div></div>
                      <Status status={task.status} text={taskStatus(task)} />
                    </button>
                  ))}
                  {!overview.tasks?.length && <div className="empty-note">还没有采集任务。提交后可在这里打开日志。</div>}
                </div>
              </aside>
            </div>
          </div>
        )}

        {view === "common" && (
          <div className="content">
            <div className="heading"><div><h1>公共采集箱</h1><p>在这里发起链接采集、查看采集结果，并将商品认领到TK采集箱。</p></div>
              <div className="secondary-actions">
              <button className="btn primary" onClick={() => { setView("collect"); setActiveTask(null); }}>＋ 通过链接采集</button></div></div>
            <div className="flowline"><div className="flow-node">① 公共采集箱<small>采集任务与货源商品</small></div><div className="flow-arrow">→</div><div className="flow-node">② TK采集箱<small>认领并转换平台数据</small></div><div className="flow-arrow">→</div><div className="flow-node">③ TikTok店铺<small>自动发布与结果回写</small></div></div>
            <div className="toolbar">
              <button
                className="btn claim-to"
                disabled={!commonSelected.length || commonBusy}
                onClick={() => startClaim(commonSelected)}
              >认领到</button>
              <button
                className="btn"
                disabled={!commonSelected.length || commonBusy}
                onClick={() => askDelete(commonSelected)}
              >批量删除{commonSelected.length ? ` (${commonSelected.length})` : ""}</button>
            </div>
            <div className="filterbar">
              <div className="filtertabs">
                {[["all","全部"],["unclaimed","未认领"],["claimed","已认领"],["failed","采集失败"]].map(([id, label]) => (
                  <button key={id} className={commonTab === id ? "active" : ""} onClick={() => setCommonTab(id)}>{label}{commonTab === id ? ` ${common.counts[id] || 0}` : ""}</button>
                ))}
              </div>
              <div className="search"><input value={commonQ} onChange={(e) => setCommonQ(e.target.value)} placeholder="标题、采集箱ID、货源ID" /><button className="btn" onClick={loadCommon}>查询</button></div>
            </div>
            <div className="card table-card">
              <table className="data-table">
                <thead><tr>
                  <th className="check-col"><input type="checkbox" checked={commonAllChecked} disabled={!common.items.length} onChange={(e) => toggleAllCommon(e.target.checked)} aria-label="全选" /></th>
                  <th>商品信息</th><th>分组</th><th>货源价格</th><th>库存</th><th>重量</th><th>采集箱ID</th><th>创建时间</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {common.items.map((item) => (
                    <tr key={item.id} className={commonSelected.includes(item.id) ? "is-selected" : ""}>
                      <td className="check-col"><input type="checkbox" checked={commonSelected.includes(item.id)} onChange={(e) => toggleCommonSelected(item.id, e.target.checked)} aria-label={`选择 ${item.title || item.id}`} /></td>
                      <td><div className="product-cell"><Cover src={item.cover || item.thumbnail} fallback={item.emoji} /><div><b>{item.title}</b><div className="meta">货源：{item.sourceId} · <span className="link">{item.source}</span></div></div></div></td>
                      <td>{item.group}</td>
                      <td>{item.currency} {item.priceMin}–{item.priceMax}</td>
                      <td>{item.stock}</td>
                      <td>{item.weight} KG</td>
                      <td>{item.boxId}</td>
                      <td>{item.createdAt}</td>
                      <td><div className="actions">
                        {item.claimed ? <button>已认领</button> : <button disabled={commonBusy} onClick={() => startClaim([item.id])}>认领</button>}
                        <button disabled={commonBusy} onClick={() => askDelete([item.id])}>删除</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!common.items.length && <div className="empty-note">暂无商品</div>}
            </div>
          </div>
        )}

        {view === "tiktok" && (
          <div className="content">
            <div className="heading"><div><h1>TK采集箱</h1><p>已转换成TikTok平台结构的商品，在这里完成类目、属性、店铺选择和发布。</p></div></div>
            <div className="toolbar">
              <button
                className="btn"
                disabled={!tkSelected.length || tkBusy}
                onClick={() => startAssignShops(tkSelected)}
              >选择店铺{tkSelected.length ? ` (${tkSelected.length})` : ""}</button>
              <button
                className="btn"
                disabled={!tkSelected.length || tkBusy}
                onClick={() => startOptimize(tkSelected).catch((e) => notify(e.message))}
              >批量AI优化{tkSelected.length ? ` (${tkSelected.length})` : ""}</button>
              <button
                className="btn green"
                disabled={!tkSelected.length || tkBusy}
                onClick={async () => {
                  const r = await api("/api/tiktok/publish", { method: "POST", body: { ids: tkSelected } });
                  loadTiktok();
                  notify(`已发布 ${r.published} 个商品`);
                }}
              >批量发布{tkSelected.length ? ` (${tkSelected.length})` : ""}</button>
              <button
                className="btn"
                disabled={!tkSelected.length || tkBusy}
                onClick={() => askDelete(tkSelected, "tiktok")}
              >批量删除{tkSelected.length ? ` (${tkSelected.length})` : ""}</button>
            </div>
            <div className="filterbar">
              <div className="filtertabs">
                {[["all","全部"],["unpublished","未发布"],["scheduled","定时发布"],["published","已发布"],["ai","AI优化中"]].map(([id, label]) => (
                  <button key={id} className={tkTab === id ? "active" : ""} onClick={() => setTkTab(id)}>{label}{tkTab === id ? ` ${tiktok.counts[id] || 0}` : ""}</button>
                ))}
              </div>
              <div className="search">
                <select className="btn" value={tkSite} onChange={(e) => setTkSite(e.target.value)}><option value="TH">TikTok TH</option><option value="MY">TikTok MY</option><option value="PH">TikTok PH</option></select>
                <input value={tkQ} onChange={(e) => setTkQ(e.target.value)} placeholder="货源ID（sourceItemIdKeyword）" /><button className="btn" onClick={loadTiktok}>查询</button>
              </div>
            </div>
            <div className="card table-card">
              <table className="data-table">
                <thead><tr>
                  <th className="check-col"><input type="checkbox" checked={tkAllChecked} disabled={!tiktok.items.length} onChange={(e) => toggleAllTk(e.target.checked)} aria-label="全选" /></th>
                  <th>商品信息</th><th>预发布类目</th><th>税前售价</th><th>库存</th><th>发布店铺</th><th>重量</th><th>校验状态</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {tiktok.items.map((item) => (
                    <tr key={item.id} className={tkSelected.includes(item.id) ? "is-selected" : ""}>
                      <td className="check-col"><input type="checkbox" checked={tkSelected.includes(item.id)} onChange={(e) => toggleTkSelected(item.id, e.target.checked)} aria-label={`选择 ${item.title || item.id}`} /></td>
                      <td><div className="product-cell"><Cover src={item.cover || item.thumbnail} fallback={item.emoji} /><div><b>{item.title}</b><div className="meta">货源：{item.sourceId || item.itemNum || "—"} · 采集箱 {item.collectBoxDetailId || item.detailId || item.id}</div></div></div></td>
                      <td><span className="badge">{item.site === "TH" ? "泰/TH" : item.site}</span> {item.category}</td>
                      <td>{item.currency} {item.priceMin}–{item.priceMax}</td>
                      <td>{item.stock}</td>
                      <td>{item.shopName || "未选择"}{!item.shopName && <><br /><span className="link" onClick={() => startAssignShops([item.id])} style={{ cursor: "pointer" }}>＋ 选择店铺</span></>}</td>
                      <td>{item.weight} KG</td>
                      <td><Status status={item.checkStatus} text={item.issues?.[0] || (item.checkStatus === "pass" ? "校验通过" : "待校验")} /></td>
                      <td><div className="actions">
                        <button disabled={tkBusy} onClick={() => startOptimize([item.id]).catch((e) => notify(e.message))}>AI优化</button>
                        <button onClick={() => startAssignShops([item.id])}>选择店铺</button>
                        <button disabled={tkBusy} onClick={async () => { const r = await api("/api/tiktok/publish", { method: "POST", body: { ids: [item.id] } }); loadTiktok(); notify(r.published ? "已提交发布" : "发布失败，请先选店铺"); }}>发布</button>
                        <button disabled={tkBusy} onClick={() => askDelete([item.id], "tiktok")}>删除</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!tiktok.items.length && <div className="empty-note">暂无商品</div>}
            </div>
          </div>
        )}

        {view === "tiktok-pro" && (
          <div className="content">
            <div className="heading"><div><h1>TK采集箱Pro</h1><p>已转换成TikTok平台结构的商品，在这里完成类目、属性、店铺选择和发布。</p></div></div>
            <div className="toolbar">
              <button
                className="btn"
                disabled={!tkProSelected.length || tkProBusy}
                onClick={() => startAssignShops(tkProSelected)}
              >选择店铺{tkProSelected.length ? ` (${tkProSelected.length})` : ""}</button>
              <button
                className="btn"
                disabled={!tkProSelected.length || tkProBusy}
                onClick={() => startOptimizePro(tkProSelected).catch((e) => notify(e.message))}
              >批量AI优化{tkProSelected.length ? ` (${tkProSelected.length})` : ""}</button>
              <button
                className="btn green"
                disabled={!tkProSelected.length || tkProBusy}
                onClick={async () => {
                  const r = await api("/api/tiktok/publish", { method: "POST", body: { ids: tkProSelected } });
                  loadTiktokPro();
                  notify(`已发布 ${r.published} 个商品`);
                }}
              >批量发布{tkProSelected.length ? ` (${tkProSelected.length})` : ""}</button>
              <button
                className="btn"
                disabled={!tkProSelected.length || tkProBusy}
                onClick={() => askDelete(tkProSelected, "tiktok-pro")}
              >批量删除{tkProSelected.length ? ` (${tkProSelected.length})` : ""}</button>
            </div>
            <div className="filterbar">
              <div className="filtertabs">
                {[["all","全部"],["unpublished","未发布"],["scheduled","定时发布"],["published","已发布"],["ai","AI优化中"]].map(([id, label]) => (
                  <button key={id} className={tkProTab === id ? "active" : ""} onClick={() => setTkProTab(id)}>{label}{tkProTab === id ? ` ${tiktokPro.counts[id] || 0}` : ""}</button>
                ))}
              </div>
              <div className="search">
                <select className="btn" value={tkProSite} onChange={(e) => setTkProSite(e.target.value)}><option value="TH">TikTok TH</option><option value="MY">TikTok MY</option><option value="PH">TikTok PH</option></select>
                <input value={tkProQ} onChange={(e) => setTkProQ(e.target.value)} placeholder="货源ID（sourceItemIdKeyword）" /><button className="btn" onClick={loadTiktokPro}>查询</button>
              </div>
            </div>
            <div className="card table-card">
              <table className="data-table">
                <thead><tr>
                  <th className="check-col"><input type="checkbox" checked={tkProAllChecked} disabled={!tiktokPro.items.length} onChange={(e) => toggleAllTkPro(e.target.checked)} aria-label="全选" /></th>
                  <th>商品信息</th><th>预发布类目</th><th>税前售价</th><th>库存</th><th>发布店铺</th><th>重量</th><th>校验状态</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {tiktokPro.items.map((item) => (
                    <tr key={item.id} className={tkProSelected.includes(item.id) ? "is-selected" : ""}>
                      <td className="check-col"><input type="checkbox" checked={tkProSelected.includes(item.id)} onChange={(e) => toggleTkProSelected(item.id, e.target.checked)} aria-label={`选择 ${item.title || item.id}`} /></td>
                      <td><div className="product-cell"><Cover src={item.cover || item.thumbnail} fallback={item.emoji} /><div><b>{item.title}</b><div className="meta">货源：{item.sourceId || item.itemNum || "—"} · 采集箱 {item.collectBoxDetailId || item.detailId || item.id}</div></div></div></td>
                      <td><span className="badge">{item.site === "TH" ? "泰/TH" : item.site}</span> {item.category}</td>
                      <td>{item.currency} {item.priceMin}–{item.priceMax}</td>
                      <td>{item.stock}</td>
                      <td>{item.shopName || "未选择"}{!item.shopName && <><br /><span className="link" onClick={() => startAssignShops([item.id])} style={{ cursor: "pointer" }}>＋ 选择店铺</span></>}</td>
                      <td>{item.weight} KG</td>
                      <td><Status status={item.checkStatus} text={item.issues?.[0] || (item.checkStatus === "pass" ? "校验通过" : "待校验")} /></td>
                      <td><div className="actions">
                        <button disabled={tkProBusy} onClick={() => startOptimizePro([item.id]).catch((e) => notify(e.message))}>AI优化</button>
                        <button onClick={() => startAssignShops([item.id])}>选择店铺</button>
                        <button disabled={tkProBusy} onClick={async () => { const r = await api("/api/tiktok/publish", { method: "POST", body: { ids: [item.id] } }); loadTiktokPro(); notify(r.published ? "已提交发布" : "发布失败，请先选店铺"); }}>发布</button>
                        <button disabled={tkProBusy} onClick={() => askDelete([item.id], "tiktok-pro")}>删除</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!tiktokPro.items.length && <div className="empty-note">暂无商品</div>}
            </div>
          </div>
        )}

        {view === "pricing-setup" && priceSetupItem && (
          <PricingSetup
            item={priceSetupItem}
            notify={notify}
            onBack={() => { setView("pricing"); setPriceSetupItem(null); }}
            onSaved={(local) => {
              setPriceSetupItem((prev) => prev ? { ...prev, ...local } : prev);
              setPriceTemplates((prev) => prev.map((row) => row.id === priceSetupItem.id ? { ...row, ...local } : row));
            }}
          />
        )}

        {view === "pricing" && (
          <div className="content">
            <div className="heading"><div><h1>定价模板</h1><p>妙手拉取模板费率，点设置补达人佣金、基建费、增长服务费并试算。</p></div></div>
            <div className="filterbar">
              <div className="search">
                <select className="btn" value={priceSiteType} onChange={(e) => setPriceSiteType(e.target.value)}>
                  <option value="">全部</option>
                  <option value="mainland">本土</option>
                  <option value="cross_border">跨境</option>
                </select>
                <input value={priceQuery} onChange={(e) => setPriceQuery(e.target.value)} placeholder="搜索模板名称" />
                <button className="btn" onClick={() => setPriceQuery(priceQuery)}>查询</button>
              </div>
            </div>
            <div className="card table-card">
              <table className="data-table">
                <thead><tr><th>模板名称</th><th>站点</th><th>利润</th><th>折扣</th><th>平台佣金</th><th>运费</th><th>其他费用</th><th>操作</th></tr></thead>
                <tbody>
                  {priceTemplates.map((item) => (
                    <tr key={item.id}>
                      <td><b>{item.name}</b></td>
                      <td className="nowrap">{item.platform || "tiktok"} / {item.site || "—"} · {item.siteTypeLabel || "—"}</td>
                      <td>{fmtPct(item.profitPercent)}</td>
                      <td>{item.discount != null ? `${item.discount} 折` : "—"}</td>
                      <td>{fmtPct(item.platformChargePercent)}</td>
                      <td>{logisticsSummary(item)}</td>
                      <td>{item.otherCharge != null ? `${item.otherCharge} 元` : "—"}</td>
                      <td><div className="actions">
                        <button type="button" onClick={() => { setPriceSetupItem(item); setView("pricing-setup"); }}>设置</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {priceLoading && <div className="empty-note">正在加载定价模板…</div>}
              {!priceLoading && !priceTemplates.length && <div className="empty-note">当前站点没有定价模板，请先在妙手 ERP 创建</div>}
            </div>
          </div>
        )}

        {view === "fx" && (
          <FxRates notify={notify} />
        )}

        {view === "freight" && (
          <FreightTable notify={notify} />
        )}

        {view === "shops" && (
          <div className="content">
            <div className="heading"><div><h1>店铺与站点</h1><p>从妙手拉取已授权店铺，并给每个店铺绑定定价模板。同步不会清掉已绑定的模板。</p></div>
              <button className="btn primary" onClick={async () => { const d = await api("/api/shops/sync", { method: "POST" }); setShops(d.items); notify("店铺已同步"); }}>同步店铺列表</button></div>
            <div className="card table-card">
              <table className="data-table">
                <thead><tr><th>店铺</th><th>平台</th><th>站点</th><th>类型</th><th>全球</th><th>定价模板</th><th>状态</th></tr></thead>
                <tbody>{shops.map((s) => {
                  const options = shopPriceTemplates.filter((item) => !s.site || !item.site || item.site === s.site);
                  if (s.pricingId && !options.some((item) => String(item.id) === String(s.pricingId))) {
                    const hit = shopPriceTemplates.find((item) => String(item.id) === String(s.pricingId));
                    options.unshift(hit || { id: s.pricingId, name: `模板 ${s.pricingId}` });
                  }
                  return (
                    <tr key={s.id}>
                      <td>{s.name}<div className="meta">{s.id}</div></td>
                      <td>{s.platformName}</td>
                      <td>{s.site}{s.siteName ? ` · ${s.siteName}` : ""}</td>
                      <td>{Number(s.isCb) === 1 ? "跨境" : "本土"}</td>
                      <td>{Number(s.isCnsc) === 1 ? "是" : "否"}</td>
                      <td>
                        <select
                          className="btn"
                          value={s.pricingId || ""}
                          onChange={async (e) => {
                            const pricingId = e.target.value;
                            try {
                              const data = await api(`/api/shops/${s.id}/pricing`, { method: "PUT", body: { pricingId } });
                              setShops((prev) => prev.map((row) => String(row.id) === String(s.id) ? { ...row, ...data.item } : row));
                              notify(pricingId ? "定价模板已绑定" : "已取消绑定");
                            } catch (err) {
                              notify(err.message);
                            }
                          }}
                        >
                          <option value="">未绑定</option>
                          {options.map((item) => (
                            <option key={item.id} value={item.id}>{item.name}{item.siteTypeLabel ? ` · ${item.siteTypeLabel}` : ""}</option>
                          ))}
                        </select>
                      </td>
                      <td><Status status={s.status} text="授权正常" /></td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {!shops.length && <div className="empty-note">还没有店铺，先同步店铺列表</div>}
            </div>
          </div>
        )}

        {view === "settings" && settings && (
          <div className="content">
            <div className="heading"><div><h1>系统设置</h1><p>凭证放在服务器 `.env`：签名格式已与妙手测试脚本对齐（x-app-key / x-timestamp / x-sign）。</p></div></div>
            <div className="collector-grid">
              <section className="card form-card">
                <div className="section-title">妙手开放平台</div>
                <div className="field"><label>运行模式</label>
                  <select value={settings.mode} onChange={(e) => setSettings({ ...settings, mode: e.target.value })}>
                    <option value="mock">模拟模式（不请求真实接口）</option>
                    <option value="live">正式模式（后端签名调用妙手）</option>
                  </select>
                </div>
                <div className="field"><label>网关地址</label><input value={settings.baseUrl} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} /></div>
                <div className="grid2">
                  <div className="field"><label>App Key</label><input value={settings.appId || ""} onChange={(e) => setSettings({ ...settings, appId: e.target.value })} /></div>
                  <div className="field"><label>App Secret</label><input type="password" placeholder={settings.hasSecret ? "已保存，留空则不修改" : "仅保存在服务器"} onChange={(e) => setSettings({ ...settings, appSecret: e.target.value })} /></div>
                </div>
                <div className="callout">App Secret 不会返回给前端明文。网关为 https://openapi-erp.91miaoshou.com 。建议在 `.env` 配置密钥，避免写进浏览器或仓库。</div>
                <div className="section-title" style={{ marginTop: 24 }}>OpenAI</div>
                <div className="field"><label>HTTP 代理</label><input placeholder="http://127.0.0.1:7890" value={settings.openaiProxy || ""} onChange={(e) => setSettings({ ...settings, openaiProxy: e.target.value })} /></div>
                <div className="callout">仅转发 OpenAI 请求。留空则使用环境变量 OPENAI_PROXY / HTTPS_PROXY。保存后立即生效，无需改 .env。</div>
                <button className="btn primary" style={{ marginTop: 16 }} onClick={async () => { const saved = await api("/api/settings", { method: "POST", body: settings }); setSettings(saved); notify("设置已保存"); }}>保存设置</button>
              </section>
              <aside className="card form-card">
                <div className="section-title">安全策略</div>
                <div className="field"><label>最低毛利 %</label><input type="number" value={settings.minMargin} onChange={(e) => setSettings({ ...settings, minMargin: Number(e.target.value) })} /></div>
                <div className="switchrow"><span>跳过异常，其他继续</span><Switch on={settings.skipOnError} onClick={() => setSettings({ ...settings, skipOnError: !settings.skipOnError })} /></div>
                <div className="api-note" style={{ marginTop: 16 }}>店铺列表接口：POST {`/open/v1/product/shop/shop/get_shop_list`}</div>
                {settings.lastError && <div className="callout">{settings.lastError}</div>}
              </aside>
            </div>
          </div>
        )}
      </main>

      <div className={`picker ${picker ? "show" : ""}`}>
        <div className="picker-modal">
          <div className="modal-head"><div><b>选择平台店铺</b><div className="meta">{claimPendingIds?.length ? `已选 ${claimPendingIds.length} 个商品，勾选店铺后确定认领` : assignPendingIds?.length ? `已选 ${assignPendingIds.length} 个商品，勾选店铺后确定` : "可跨平台勾选，同一平台只能选一个店铺；切换平台或站点会重新拉取列表"}</div></div><button className="btn" onClick={closeShopPicker}>×</button></div>
          <div className="picker-body">
            <div className="picker-filter">
              <div className="field"><label>平台</label>
                <select value={pickerPlatform} onChange={(e) => { setPickerPlatform(e.target.value); setPickerSite(SITE_OPTIONS[e.target.value][0][0]); setShopSearch(""); }}>
                  <option value="tiktok">TikTok Shop</option><option value="shopee">Shopee</option><option value="ozon">Ozon</option>
                </select>
              </div>
              <div className="field" style={{ marginTop: 14 }}><label>站点</label>
                <select value={pickerSite} onChange={(e) => { setPickerSite(e.target.value); setShopSearch(""); }}>
                  {SITE_OPTIONS[pickerPlatform].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="callout" style={{ marginTop: 14 }}>切换平台 / 站点需要刷新列表哦</div>
            </div>
            <div>
              <div className="selected-block">
                <div className="selected-head"><b>已选择</b><span className="meta">{draftList.length} 个店铺</span></div>
                {draftList.length ? (
                  <div className="shop-tags">
                    {draftList.map((shop) => (
                      <span className="shop-tag removable" key={shop.id}>
                        {shop.platformName || shop.platform} · {shop.site} · {shop.name}
                        <button type="button" aria-label="移除" onClick={() => toggleDraftShop(shop, false)}>×</button>
                      </span>
                    ))}
                  </div>
                ) : <div className="hint">还没有选择店铺，从下方列表勾选</div>}
              </div>
              <div className="api-note">POST /open/v1/product/shop/shop/get_shop_list · {pickerPlatform} · {pickerSite} · 切换后自动刷新</div>
              <div className="search" style={{ marginBottom: 8 }}><input value={shopSearch} onChange={(e) => setShopSearch(e.target.value)} placeholder="搜索店铺名称" style={{ width: "100%" }} /></div>
              <div className="picker-list">
                {pickerLoading && <div className="empty-note">正在刷新 {pickerPlatform} / {pickerSite} 店铺列表…</div>}
                {!pickerLoading && pickerError && <div className="empty-note">{pickerError}</div>}
                {!pickerLoading && !pickerError && pickerShops.length ? pickerShops.map((shop) => {
                  const selected = Boolean(draftSelected[shop.id]);
                  const blocked = !selected && Boolean(samePlatformShop(draftList, shop));
                  return (
                  <label className="shop-row" key={shop.id}>
                    <input type="checkbox" checked={selected} disabled={blocked} onChange={(e) => toggleDraftShop(shop, e.target.checked)} />
                    <span><b>{shop.name}</b><br /><small>{shop.platformName} · {shop.site} · {shop.type}{blocked ? " · 该平台已选店铺" : ""}</small></span>
                    <span className="status s-ok">授权正常</span>
                  </label>
                  );
                }) : null}
                {!pickerLoading && !pickerError && !pickerShops.length && <div className="empty-note">当前平台站点暂无可用店铺</div>}
              </div>
            </div>
          </div>
          <div className="modal-foot"><span className="meta" style={{ marginRight: "auto" }}>已选择 {draftList.length} 个店铺</span>
            <button className="btn" onClick={closeShopPicker}>取消</button>
            <button className="btn primary" onClick={confirmShopPicker}>确认选择</button></div>
        </div>
      </div>

      {deletePendingIds?.length ? (
        <div className="picker show">
          <div className="picker-modal" style={{ width: 420 }}>
            <div className="modal-head"><b>确认删除</b><button className="btn" onClick={() => setDeletePendingIds(null)}>×</button></div>
            <div className="modal-body">
              <p style={{ margin: "0 0 10px" }}>确定删除已选的 <b>{deletePendingIds.length}</b> 个{deletePendingBox === "tiktok-pro" ? "TK采集箱Pro" : deletePendingBox === "tiktok" ? "TK采集箱" : "公共采集箱"}商品？删除后不可恢复。</p>
              <div className="meta">
                {(deletePendingBox === "tiktok-pro" ? tiktokPro.items : deletePendingBox === "tiktok" ? tiktok.items : common.items).filter((item) => deletePendingIds.includes(item.id)).slice(0, 4).map((item) => (
                  <div key={item.id}>{item.title || item.sourceId || item.id}</div>
                ))}
                {deletePendingIds.length > 4 ? <div>…还有 {deletePendingIds.length - 4} 个</div> : null}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDeletePendingIds(null)}>取消</button>
              <button className="btn danger" disabled={commonBusy || tkBusy || tkProBusy} onClick={() => confirmDelete().catch((e) => notify(e.message))}>确定删除</button>
            </div>
          </div>
        </div>
      ) : null}

      <div className={`drawer ${drawer ? "show" : ""}`} onClick={(e) => { if (e.target === e.currentTarget && activeTask?.status !== "running") setDrawer(false); }}>
        <div className="modal log-modal">
          <div className="modal-head"><div><b>{activeTask?.kind === "optimize"
            ? (activeTask?.status === "running" || activeTask?.status === "queued" ? "AI 优化处理中" : "AI 优化日志")
            : activeTask?.kind === "claim"
              ? (activeTask?.status === "running" || activeTask?.status === "queued" ? "认领处理中" : "认领日志")
            : (activeTask?.status === "running" || activeTask?.status === "queued" ? (publishWhen === "manual" ? "采集处理中" : "采集并上架处理中") : "采集日志")
          }</b><div className="meta">{activeTask?.title || (activeTask?.kind === "optimize" ? "从获取详情开始，按店铺逐个 get / 优化 / save" : activeTask?.kind === "claim" ? "从平台认领开始，不重新采集链接" : "核对 fetch_item、采集箱 ID、认领每一步")}{activeTask?.error ? ` · ${activeTask.error}` : ""}</div></div><button className="btn" onClick={() => setDrawer(false)}>×</button></div>
          <div className="modal-body">
            <div className="form">
              {activeTask && (
                <div>
                  <div className="progress"><span style={{ width: `${activeTask.progress || 0}%` }} /></div>
                  <div className="steps">
                    {(activeTask.steps || []).map((step, i) => (
                      <div className={`step ${step.state}`} key={i}><span>{step.label}</span><span>{step.state === "done" ? "完成" : step.state === "current" ? "处理中" : "等待"}</span></div>
                    ))}
                  </div>
                  <div className="usage-box">
                    <div className="usage-head">OpenAI tokens</div>
                    <div className="usage-totals">
                      <span>input_tokens {(activeTask.openaiUsage?.input_tokens ?? 0)}</span>
                      <span>output_tokens {(activeTask.openaiUsage?.output_tokens ?? 0)}</span>
                      <span>total_tokens {(activeTask.openaiUsage?.total_tokens ?? 0)}</span>
                    </div>
                    {(activeTask.openaiUsage?.calls || []).length ? (
                      <div className="usage-calls">
                        {(activeTask.openaiUsage.calls || []).map((call, i) => (
                          <div className="usage-call" key={`${call.t}-${i}`}>
                            <span>{call.label}</span>
                            <span>input_tokens {call.input_tokens}</span>
                            <span>output_tokens {call.output_tokens}</span>
                            <span>total_tokens {call.total_tokens}</span>
                          </div>
                        ))}
                      </div>
                    ) : <div className="usage-empty">还没有 OpenAI 调用</div>}
                  </div>
                  <div className="log-head">运行日志<span>红字是失败点，黄字是警告</span></div>
                  <div className="log-box">
                    {(activeTask.logs || []).length ? (activeTask.logs || []).map((line, i) => (
                      <div className={`log-line log-${line.level || "info"}`} key={`${line.t}-${i}`}>
                        <span className="log-time">{line.t}</span>
                        <span className="log-lv">{logLevelText(line.level)}</span>
                        <span className="log-msg">{line.message}{line.extra ? `  ${line.extra}` : ""}</span>
                      </div>
                    )) : <div className="empty-note">还没有日志。任务跑起来后会逐条出现。</div>}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={() => setDrawer(false)}>{activeTask?.status === "running" ? "后台运行" : "关闭"}</button>
          </div>
        </div>
      </div>
      <div className={`toast ${toast ? "show" : ""}`}>{toast}</div>
    </div>
  );
}
