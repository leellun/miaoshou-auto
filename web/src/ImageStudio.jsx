import { useState } from "react";

const MARKETS = [
  { country: "泰国", language: "泰语", site: "TH" },
  { country: "马来西亚", language: "马来语", site: "MY" },
  { country: "菲律宾", language: "英语", site: "PH" },
  { country: "越南", language: "越南语", site: "VN" },
  { country: "新加坡", language: "英语", site: "SG" },
  { country: "印度尼西亚", language: "印尼语", site: "ID" },
];

const PLATFORMS = ["TikTok Shop", "Shopee", "Lazada", "Amazon", "Temu"];
const LANGUAGES = ["泰语", "马来语", "英语", "印尼语", "越南语", "简体中文", "繁体中文"];
const ASPECTS = ["1:1", "3:4", "4:5", "9:16", "original"];
const IMAGE_TYPES = [
  { id: "with_text", label: "with_text 允许文字" },
  { id: "white_background", label: "white_background 白底无文字" },
  { id: "no_text", label: "no_text 无文字" },
];
const STRENGTHS = [
  { id: "low", label: "low 微调与排版" },
  { id: "medium", label: "medium 构图与背景优化" },
  { id: "high", label: "high 深度视觉重构" },
];

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`${file.name} 读取失败`));
    reader.readAsDataURL(file);
  });
}

function marketOf(country) {
  return MARKETS.find((item) => item.country === country) || MARKETS[0];
}

export default function ImageStudio({ notify }) {
  const [mode, setMode] = useState("main");
  const [platform, setPlatform] = useState("TikTok Shop");
  const [country, setCountry] = useState("泰国");
  const [language, setLanguage] = useState("泰语");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [imageType, setImageType] = useState("with_text");
  const [excludedCopy, setExcludedCopy] = useState("");
  const [additionalCopy, setAdditionalCopy] = useState("");
  const [redesignStrength, setRedesignStrength] = useState("high");
  const [mainProduct, setMainProduct] = useState("auto");
  const [previews, setPreviews] = useState([]);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState([]);
  const [images, setImages] = useState([]);
  const site = marketOf(country).site;
  const detailParams = mode === "detail" || mode === "plan";

  async function onPickFiles(event) {
    const picked = Array.from(event.target.files || []);
    event.target.value = "";
    if (!picked.length) return;
    try {
      const next = [];
      for (const file of picked) {
        const data = await readFileAsDataUrl(file);
        next.push({ filename: file.name, data, key: `${file.name}-${file.size}-${file.lastModified}` });
      }
      setPreviews((prev) => [...prev, ...next]);
    } catch (err) {
      notify?.(err.message);
    }
  }

  function changeCountry(value) {
    setCountry(value);
    setLanguage(marketOf(value).language);
  }

  async function generate() {
    if (!previews.length) {
      notify?.("请先上传原图");
      return;
    }
    setBusy(true);
    setLogs([]);
    setImages([]);
    try {
      const res = await fetch("/api/studio/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          site,
          platform,
          country,
          language,
          aspect_ratio: aspectRatio,
          image_type: imageType,
          excluded_copy: excludedCopy,
          additional_copy: additionalCopy,
          redesign_strength: redesignStrength,
          main_product: mainProduct,
          files: previews,
        }),
      });
      const data = await res.json().catch(() => ({}));
      setLogs(data.logs || []);
      if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
      setImages(data.images || []);
      notify?.(data.images?.length ? `已生成 ${data.images.length} 张` : "生成完成");
    } catch (err) {
      notify?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>电商作图</h1>
          <p>主图/SKU 用商品图提示词。详情图每张直接分析出图。规划出图先拆页再逐页分析出图。</p>
        </div>
      </div>

      <div className="filterbar">
        <div className="filtertabs">
          <button type="button" className={mode === "main" ? "active" : ""} onClick={() => setMode("main")}>主图 / SKU 图</button>
          <button type="button" className={mode === "detail" ? "active" : ""} onClick={() => setMode("detail")}>详情图</button>
          <button type="button" className={mode === "plan" ? "active" : ""} onClick={() => setMode("plan")}>规划出图</button>
        </div>
      </div>

      <div className="studio-split">
        <div className="card panel studio-left">
          <div className="panel-head">
            <h2>原图 {previews.length ? `(${previews.length})` : ""}</h2>
            <label className="btn studio-upload">
              上传图片
              <input type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
            </label>
          </div>
          {!previews.length && <div className="empty-note">上传一张或多张商品图</div>}
          <div className="studio-thumbs studio-thumbs-sm">
            {previews.map((item) => (
              <figure key={item.key} className="studio-thumb">
                <img src={item.data} alt={item.filename} />
                <figcaption>
                  <span>{item.filename}</span>
                  <button type="button" className="link" onClick={() => setPreviews((prev) => prev.filter((row) => row.key !== item.key))}>移除</button>
                </figcaption>
              </figure>
            ))}
          </div>

          <div className="form studio-fields">
            <div className="field">
              <label>目标平台 (platform)</label>
              <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                {PLATFORMS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
            <div className="field">
              <label>销售国家/地区 (country)</label>
              <select value={country} onChange={(e) => changeCountry(e.target.value)}>
                {MARKETS.map((item) => <option key={item.country} value={item.country}>{item.country}</option>)}
              </select>
            </div>
            <div className="field">
              <label>图片文案语言 (target_language)</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
            <div className="field">
              <label>图片宽高比 (aspect_ratio)</label>
              <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                {ASPECTS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
            <div className="field">
              <label>图片类型 (image_type)</label>
              <select value={imageType} onChange={(e) => setImageType(e.target.value)}>
                {IMAGE_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{detailParams ? "排除文案 (excluded_strs)" : "排除文案 (excluded_copy)"}</label>
              <textarea
                value={excludedCopy}
                onChange={(e) => setExcludedCopy(e.target.value)}
                placeholder="多个条件用中文或英文分号分隔"
              />
            </div>
            {detailParams && (
              <>
                <div className="field">
                  <label>补充商品信息 (additional_copy)</label>
                  <textarea
                    value={additionalCopy}
                    onChange={(e) => setAdditionalCopy(e.target.value)}
                    placeholder="图片未展示的商品信息，用中文或英文分号分隔；只进详情文案，不上图"
                  />
                </div>
                <div className="field">
                  <label>重设计强度 (redesign_strength)</label>
                  <select value={redesignStrength} onChange={(e) => setRedesignStrength(e.target.value)}>
                    {STRENGTHS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>主销售商品 (main_product)</label>
                  <input
                    value={mainProduct}
                    onChange={(e) => setMainProduct(e.target.value)}
                    placeholder="auto"
                  />
                </div>
              </>
            )}
          </div>

          <button className="btn primary wide" type="button" disabled={busy || !previews.length} onClick={generate}>
            {busy ? "生成中…" : "开始作图"}
          </button>
        </div>

        <div className="card panel studio-right">
          <div className="panel-head"><h2>结果 {images.length ? `(${images.length})` : ""}</h2></div>
          {busy && <div className="empty-note">正在按提示词分析并生图…</div>}
          {!busy && !images.length && <div className="empty-note">生成后显示在这里</div>}
          <div className="studio-thumbs">
            {images.map((item) => (
              <figure key={item.url} className="studio-thumb">
                <img src={item.url} alt={item.filename} />
                <figcaption>
                  <span>{item.filename}</span>
                  <a className="link" href={item.url} download={item.filename}>下载</a>
                </figcaption>
              </figure>
            ))}
          </div>
          {!!logs.length && (
            <div className="studio-log">
              <div className="panel-head"><h2>过程日志</h2></div>
              <div className="log-box">
                {logs.map((line, index) => (
                  <div key={`${index}-${line.slice(0, 24)}`} className="log-line log-info">
                    <span className="log-time">{index + 1}</span>
                    <span className="log-lv">info</span>
                    <span className="log-msg">{line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
