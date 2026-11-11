import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

function dashMoney(value) {
  if (value == null || value === "") return "—";
  return Number(value).toFixed(2);
}

function moneyPair(cny, fx) {
  if (cny == null || cny === "") return "—";
  const rate = Number(fx?.rate);
  if (!Number.isFinite(rate) || rate <= 0) return `${dashMoney(cny)} CNY`;
  return `${dashMoney(cny)} CNY（${dashMoney(Number(cny) * rate)} ${fx.currency}）`;
}

function Field({ label, required, children, className = "" }) {
  return (
    <div className={`ms-field ${className}`}>
      <label>{required ? <i>*</i> : null}{label}</label>
      {children}
    </div>
  );
}

function FeeBox({ label, suffix, value, onChange }) {
  return (
    <div className="ms-fee">
      <div className="ms-fee-label">{label}</div>
      <div className="ms-fee-input">
        <input type="number" step="0.01" value={value ?? ""} onChange={onChange} />
        <span>{suffix}</span>
      </div>
    </div>
  );
}

const MAINLAND_LOGISTICS_OPTIONS = [
  { value: "fixed", label: "统一运费" },
  { value: "first_continued", label: "按首重续重" },
];

const THIRD_PARTY_OPTIONS = [
  { value: "first_continued", label: "按首重续重" },
  { value: "fixed", label: "统一运费" },
  { value: "byWeightAndFixedCharge", label: "按重量计费" },
];

const SITES = [
  { value: "TH", label: "泰国" },
  { value: "MY", label: "马来西亚" },
  { value: "PH", label: "菲律宾" },
];

function logisticsKey(type) {
  const t = String(type || "");
  if (t === "official_freight_tpl" || t === "officialFreightTpl") return "officialFreightTpl";
  if (t === "byWeightAndFixedCharge" || t === "weight_interval") return "byWeightAndFixedCharge";
  if (t === "first_continued") return "first_continued";
  return "fixed";
}

function profitKey(value) {
  if (value === "cost" || /成本/.test(value || "")) return "cost";
  if (value === "fixed" || /固定/.test(value || "")) return "fixed";
  return "sale";
}

function siteTypeKey(item) {
  const type = String(item?.siteType || "");
  if (type === "cross_border" || type === "跨境") return "cross_border";
  if (type === "mainland" || type === "本土") return "mainland";
  return item?.buyerLogisticCharge != null && String(item.buyerLogisticCharge).trim() !== "" ? "cross_border" : "mainland";
}

function fieldsFromItem(item = {}) {
  return {
    name: item.name ?? "",
    site: item.site || "TH",
    siteType: siteTypeKey(item),
    profitType: profitKey(item.profitType),
    profitPercent: item.profitPercent ?? "",
    discount: item.discount ?? "",
    logisticsComputeType: logisticsKey(item.logisticsComputeType),
    isCalLightCargo: item.isCalLightCargo === 1 || item.isCalLightCargo === "1" ? 1 : 0,
    lightCargoCoefficient: item.lightCargoCoefficient ?? "",
    firstWeightCharge: item.firstWeightCharge ?? "",
    firstWeightInterval: item.firstWeightInterval ?? "",
    continuedWeightCharge: item.continuedWeightCharge ?? "",
    continuedWeightInterval: item.continuedWeightInterval ?? "",
    logisticsCharge: item.logisticsCharge ?? "",
    weightRefType: item.weightRefType === "sku" || item.weightSource === "sku" ? "sku" : "spu",
    buyerLogisticCharge: item.buyerLogisticCharge ?? "",
    hasSellerLogisticCharge: item.hasSellerLogisticCharge === 1 || item.hasSellerLogisticCharge === "1" ? 1 : 0,
    sellerLogisticCharge: item.sellerLogisticCharge ?? "",
    platformChargePercent: item.platformChargePercent ?? "",
    paymentChargePercent: item.paymentChargePercent ?? "",
    withdrawChargePercent: item.withdrawChargePercent ?? "",
    commissionPercent: item.commissionPercent ?? 0,
    fixedInfraFee: item.fixedInfraFee ?? 0,
    growthPercent: item.growthPercent ?? 0,
    vatChargePercent: item.vatChargePercent ?? item.vatPercent ?? 0,
    tariffChargePercent: item.tariffChargePercent ?? item.tariffPercent ?? 0,
    otherCharge: item.otherCharge ?? "",
    priceProcessDecimalType: item.priceProcessDecimalType === "floor" ? "floor" : item.priceProcessDecimalType === "ceil" ? "ceil" : "round",
    priceTail: item.priceTail ?? "",
  };
}

function toNumberOrEmpty(raw) {
  if (raw === "" || raw == null) return "";
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

export default function PricingSetup({ item, onSaved, notify }) {
  const [local, setLocal] = useState(() => fieldsFromItem(item));
  const [cost, setCost] = useState("");
  const [wReal, setWReal] = useState("");
  const [L, setL] = useState("");
  const [W, setW] = useState("");
  const [H, setH] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [calcBusy, setCalcBusy] = useState(false);
  const [fx, setFx] = useState({ rate: "", currency: "THB" });

  useEffect(() => {
    setLocal(fieldsFromItem(item));
  }, [item]);

  const logisticsType = logisticsKey(local.logisticsComputeType);
  const official = logisticsType === "officialFreightTpl";
  const firstContinued = logisticsType === "first_continued";
  const perKg = logisticsType === "byWeightAndFixedCharge";
  const isCrossBorder = local.siteType === "cross_border";
  const lightOn = local.isCalLightCargo === 1 || local.isCalLightCargo === "1";
  const needWeight = official || firstContinued || perKg;
  const needSize = firstContinued && lightOn;

  useEffect(() => {
    api("/api/fx-rates").then((data) => {
      const row = (data.rows || []).find((itemRow) => itemRow.site === (local.site || "TH"));
      const currency = row?.currency || "THB";
      setFx({ rate: data.rates?.[currency] ?? "", currency });
    }).catch(() => {});
  }, [local.site]);

  const merged = useMemo(() => ({
    ...item,
    ...local,
    siteType: isCrossBorder ? "cross_border" : "mainland",
    siteTypeLabel: isCrossBorder ? "跨境" : "本土",
    logisticsComputeType: logisticsType,
    weightRefType: local.weightRefType === "sku" ? "sku" : "spu",
  }), [item, local, isCrossBorder, logisticsType]);
  const nameLen = String(local.name || "").length;

  function patchLocal(key, value) {
    setLocal((prev) => ({ ...prev, [key]: value }));
  }

  function patchNum(key, raw) {
    patchLocal(key, toNumberOrEmpty(raw));
  }

  async function saveLocal() {
    setSaving(true);
    try {
      const data = await api(`/api/price-templates/${item.id}/local`, {
        method: "PUT",
        body: merged,
      });
      onSaved?.(data.item);
      notify?.("本地费率已保存");
    } catch (err) {
      notify?.(err.message);
    } finally {
      setSaving(false);
    }
  }

  function resetTrial() {
    setCost("");
    setWReal("");
    setL("");
    setW("");
    setH("");
    setResult(null);
    setError("");
  }

  async function runTrial() {
    setCalcBusy(true);
    setError("");
    try {
      const data = await api("/api/price-templates/trial", {
        method: "POST",
        body: {
          template: merged,
          kind: isCrossBorder ? "cross_border" : "mainland",
          cost: Number(cost),
          wReal: needWeight ? Number(wReal) : undefined,
          L: needSize ? Number(L) : undefined,
          W: needSize ? Number(W) : undefined,
          H: needSize ? Number(H) : undefined,
        },
      });
      setResult(data.result);
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setCalcBusy(false);
    }
  }

  const fees = result?.fees;
  const pretax = result && fees
    ? Number(result.priceAfterDiscount) - Number(fees.tariff || 0) - Number(fees.vat || 0) - Number(isCrossBorder ? fees.firstMile || 0 : 0)
    : null;

  return (
    <div className="content ms-page">
      <div className="ms-page-head">
        <h1>编辑定价模板</h1>
        <button className="btn primary" type="button" disabled={saving} onClick={saveLocal}>{saving ? "保存中…" : "保存本地费率"}</button>
      </div>
      <div className="ms-layout">
        <section className="ms-main">
          <Field label="模板名称" required>
            <div className="ms-name">
              <input value={local.name || ""} maxLength={64} onChange={(e) => patchLocal("name", e.target.value)} />
              <span>{nameLen}/64</span>
            </div>
          </Field>
          <div className="ms-split">
            <Field label="站点" required>
              <select value={local.site || "TH"} onChange={(e) => patchLocal("site", e.target.value)}>
                {SITES.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
              </select>
            </Field>
            <div className="ms-fx">
              <span>汇率：1CNY(人民币) ≈</span>
              <input value={fx.rate} readOnly />
              <b>{fx.currency}</b>
            </div>
          </div>
          <Field label="类型" required>
            <select value={isCrossBorder ? "cross_border" : "mainland"} onChange={(e) => patchLocal("siteType", e.target.value)}>
              <option value="mainland">本土</option>
              <option value="cross_border">跨境</option>
            </select>
          </Field>

          <div className="ms-block-head">
            <b>定价参数</b>
            <span>人民币(CNY) · 千克(KG)</span>
          </div>

          <div className="ms-block-title"><span className="ms-dot profit" />利润信息</div>
          <div className="ms-split">
            <Field label="利润方式">
              <select value={local.profitType} onChange={(e) => patchLocal("profitType", e.target.value)}>
                <option value="cost">成本利润率</option>
                <option value="sale">售价利润率</option>
                <option value="fixed">固定利润</option>
              </select>
            </Field>
            <Field label="利润率" required>
              <div className="ms-suffix"><input type="number" step="0.01" value={local.profitPercent ?? ""} onChange={(e) => patchNum("profitPercent", e.target.value)} /><span>%</span></div>
            </Field>
          </div>
          <Field label="折扣">
            <div className="ms-suffix"><input type="number" step="0.01" value={local.discount ?? ""} onChange={(e) => patchNum("discount", e.target.value)} /><span>折</span></div>
          </Field>

          <div className="ms-block-title"><span className="ms-dot cost" />成本信息</div>
          {isCrossBorder ? (
            <Field label="头程运费" required>
              <select
                value={official ? "officialFreightTpl" : "third"}
                onChange={(e) => patchLocal("logisticsComputeType", e.target.value === "officialFreightTpl" ? "officialFreightTpl" : (official ? "first_continued" : logisticsType))}
              >
                <option value="officialFreightTpl">使用官方跨境物流（跨境物流小包）</option>
                <option value="third">第三方物流（自行发货到海外仓）</option>
              </select>
            </Field>
          ) : null}
          {isCrossBorder && official ? (
            <div className="hint" style={{ margin: "-4px 0 14px 106px" }}>头程按「跨境运费」表计算（站点币→人民币），尾程不计入藏价。</div>
          ) : null}
          {(!isCrossBorder || !official) ? (
            <Field label={isCrossBorder ? "计费方式" : "运费(藏价)"} className="ms-choice">
              <div className="ms-radios">
                {(isCrossBorder ? THIRD_PARTY_OPTIONS : MAINLAND_LOGISTICS_OPTIONS).map((opt) => (
                  <label key={opt.value} className={logisticsType === opt.value ? "on" : ""}>
                    <input type="radio" name="logisticsComputeType" checked={logisticsType === opt.value} onChange={() => patchLocal("logisticsComputeType", opt.value)} /> {opt.label}
                  </label>
                ))}
              </div>
            </Field>
          ) : null}
          {firstContinued ? (
            <>
              <div className="ms-split">
                <Field label="计算抛重">
                  <button type="button" className={`switch ${lightOn ? "on" : ""}`} aria-label="计算抛重" onClick={() => patchLocal("isCalLightCargo", lightOn ? 0 : 1)} />
                </Field>
                {lightOn ? (
                  <Field label="轻抛系数" required>
                    <input type="number" step="1" value={local.lightCargoCoefficient ?? ""} onChange={(e) => patchNum("lightCargoCoefficient", e.target.value)} />
                  </Field>
                ) : <div />}
              </div>
              <div className="ms-split">
                <Field label="首重价格" required>
                  <div className="ms-weight-price">
                    <input type="number" step="0.01" value={local.firstWeightCharge ?? ""} onChange={(e) => patchNum("firstWeightCharge", e.target.value)} />
                    <span>CNY /</span>
                    <input type="number" step="0.001" value={local.firstWeightInterval ?? ""} onChange={(e) => patchNum("firstWeightInterval", e.target.value)} />
                    <span>KG</span>
                  </div>
                </Field>
                <Field label="续重价格" required>
                  <div className="ms-weight-price">
                    <input type="number" step="0.01" value={local.continuedWeightCharge ?? ""} onChange={(e) => patchNum("continuedWeightCharge", e.target.value)} />
                    <span>CNY /</span>
                    <input type="number" step="0.001" value={local.continuedWeightInterval ?? ""} onChange={(e) => patchNum("continuedWeightInterval", e.target.value)} />
                    <span>KG</span>
                  </div>
                </Field>
              </div>
            </>
          ) : perKg ? (
            <div className="ms-split">
              <Field label="计费标准" required>
                <div className="ms-suffix">
                  <input type="number" step="0.01" value={local.firstWeightCharge ?? ""} onChange={(e) => patchNum("firstWeightCharge", e.target.value)} />
                  <span>CNY/KG</span>
                </div>
              </Field>
              <Field label="固定费用">
                <div className="ms-suffix">
                  <input type="number" step="0.01" value={local.continuedWeightCharge ?? ""} onChange={(e) => patchNum("continuedWeightCharge", e.target.value)} />
                  <span>CNY</span>
                </div>
              </Field>
            </div>
          ) : official ? null : (
            <Field label="统一运费"><input type="number" step="0.01" value={local.logisticsCharge ?? ""} onChange={(e) => patchNum("logisticsCharge", e.target.value)} /></Field>
          )}
          <Field label="重量取值" className="ms-choice">
            <div className="ms-radios">
              <label className={local.weightRefType !== "sku" ? "on" : ""}>
                <input type="radio" name="weightRefType" checked={local.weightRefType !== "sku"} onChange={() => patchLocal("weightRefType", "spu")} /> 产品包裹重量
              </label>
              <label className={local.weightRefType === "sku" ? "on" : ""}>
                <input type="radio" name="weightRefType" checked={local.weightRefType === "sku"} onChange={() => patchLocal("weightRefType", "sku")} /> SKU重量
              </label>
            </div>
          </Field>
          {isCrossBorder ? (
            <>
              <Field label="尾程运费" required>
                <div className="ms-lastmile">
                  <div className="ms-suffix">
                    <input type="number" step="0.01" value={local.buyerLogisticCharge ?? ""} onChange={(e) => patchNum("buyerLogisticCharge", e.target.value)} />
                    <span>CNY</span>
                  </div>
                  <label className="ms-check">
                    <input type="checkbox" checked={Boolean(local.hasSellerLogisticCharge)} onChange={(e) => patchLocal("hasSellerLogisticCharge", e.target.checked ? 1 : 0)} />
                    商家承担部分运费
                  </label>
                </div>
              </Field>
              {local.hasSellerLogisticCharge ? (
                <Field label="商家运费减免">
                  <div className="ms-suffix">
                    <input type="number" step="0.01" value={local.sellerLogisticCharge ?? ""} placeholder="由商家承担" onChange={(e) => patchNum("sellerLogisticCharge", e.target.value)} />
                    <span>CNY</span>
                  </div>
                </Field>
              ) : null}
            </>
          ) : null}

          <Field label="平台费用" className="ms-fees-wrap">
            <div className={`ms-fees${isCrossBorder ? " cross" : ""}`}>
              <FeeBox label="平台佣金费率" suffix="%" value={local.platformChargePercent} onChange={(e) => patchNum("platformChargePercent", e.target.value)} />
              <FeeBox label="交易手续费率" suffix="%" value={local.paymentChargePercent} onChange={(e) => patchNum("paymentChargePercent", e.target.value)} />
              <FeeBox label="提现手续费率" suffix="%" value={local.withdrawChargePercent} onChange={(e) => patchNum("withdrawChargePercent", e.target.value)} />
              <FeeBox label="达人佣金率" suffix="%" value={local.commissionPercent} onChange={(e) => patchNum("commissionPercent", e.target.value)} />
              <FeeBox label="平台基础设施费" suffix="CNY" value={local.fixedInfraFee} onChange={(e) => patchNum("fixedInfraFee", e.target.value)} />
              <FeeBox label="电商增长服务费" suffix="%" value={local.growthPercent} onChange={(e) => patchNum("growthPercent", e.target.value)} />
              {isCrossBorder ? (
                <>
                  <FeeBox label="增值税率" suffix="%" value={local.vatChargePercent} onChange={(e) => patchNum("vatChargePercent", e.target.value)} />
                  <FeeBox label="关税税率" suffix="%" value={local.tariffChargePercent} onChange={(e) => patchNum("tariffChargePercent", e.target.value)} />
                </>
              ) : null}
            </div>
          </Field>
          <Field label="其他费用">
            <div className="ms-suffix"><input type="number" step="0.01" value={local.otherCharge ?? ""} onChange={(e) => patchNum("otherCharge", e.target.value)} /><span>CNY</span></div>
          </Field>

          <div className="ms-block-title"><span className="ms-dot tail" />尾数处理</div>
          <div className="ms-split">
            <Field label="小数处理方式">
              <select value={local.priceProcessDecimalType} onChange={(e) => patchLocal("priceProcessDecimalType", e.target.value)}>
                <option value="floor">向下</option>
                <option value="ceil">向上</option>
                <option value="round">四舍五入</option>
              </select>
            </Field>
            <Field label="尾数金额"><input type="number" step="0.01" value={local.priceTail ?? ""} onChange={(e) => patchNum("priceTail", e.target.value)} /></Field>
          </div>
        </section>

        <aside className="ms-trial">
          <div className="ms-trial-head">售价试算</div>
          <div className="ms-trial-body">
            <Field label="产品采购价" required>
              <div className="ms-suffix"><input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} /><span>CNY</span></div>
            </Field>
            {needWeight ? (
              <Field label={local.weightRefType === "sku" ? "SKU重量" : "产品包裹重量"} required>
                <div className="ms-suffix"><input type="number" step="0.001" value={wReal} onChange={(e) => setWReal(e.target.value)} /><span>KG</span></div>
              </Field>
            ) : null}
            {needSize ? (
              <Field label="包裹尺寸" required>
                <div className="ms-size">
                  <input type="number" placeholder="长" value={L} onChange={(e) => setL(e.target.value)} />
                  <span>cm</span>
                  <input type="number" placeholder="宽" value={W} onChange={(e) => setW(e.target.value)} />
                  <span>cm</span>
                  <input type="number" placeholder="高" value={H} onChange={(e) => setH(e.target.value)} />
                  <span>cm</span>
                </div>
              </Field>
            ) : null}
            <div className="ms-trial-actions">
              <button type="button" className="ms-reset" onClick={resetTrial}>重置</button>
              <button type="button" className="ms-calc" disabled={calcBusy} onClick={runTrial}>{calcBusy ? "计算中" : "计算"}</button>
            </div>
            {error ? <div className="callout" style={{ margin: "10px 16px 0" }}>{error}</div> : null}

            <div className="ms-trial-sec">计算结果</div>
            <div className="ms-line"><span>税前价格</span><b className={pretax != null ? "hot" : ""}>{pretax != null ? moneyPair(pretax, fx) : "—"}</b></div>
            <div className="ms-line"><span>产品售价(原价)</span><b className={result ? "hot" : ""}>{result ? moneyPair(result.priceOriginal, fx) : "—"}</b></div>
            <div className="ms-line"><span>产品售价(折后)</span><b className={result ? "hot" : ""}>{result ? moneyPair(result.priceAfterDiscount, fx) : "—"}</b></div>
            <div className="ms-line"><span>利润</span><b className={result ? "hot" : ""}>{result ? moneyPair(result.profit, fx) : "—"}</b></div>
            <div className="ms-trial-sec">详细费用</div>
            <div className="ms-line"><span>运费(藏价)</span><b>{fees ? moneyPair(fees.freight, fx) : "—"}</b></div>
            {isCrossBorder ? (
              <div className="ms-line sub"><span>跨境物流成本</span><b>{fees ? moneyPair(fees.firstMile, fx) : "—"}</b></div>
            ) : null}
            <div className="ms-line"><span>TikTok平台费用</span><b>{fees ? moneyPair(fees.tiktokPlatform, fx) : "—"}</b></div>
            <div className="ms-line sub"><span>交易手续费</span><b>{fees ? moneyPair(fees.payment, fx) : "—"}</b></div>
            <div className="ms-line sub"><span>平台佣金费</span><b>{fees ? moneyPair(fees.platform, fx) : "—"}</b></div>
            <div className="ms-line sub"><span>提现手续费</span><b>{fees ? moneyPair(fees.withdraw, fx) : "—"}</b></div>
            <div className="ms-line sub"><span>达人佣金费</span><b>{fees ? moneyPair(fees.commission, fx) : "—"}</b></div>
            <div className="ms-line sub"><span>平台基础设施费</span><b>{fees ? moneyPair(fees.infra, fx) : "—"}</b></div>
            <div className="ms-line sub"><span>电商增长服务费</span><b>{fees ? moneyPair(fees.growth, fx) : "—"}</b></div>
            {isCrossBorder ? (
              <>
                <div className="ms-line sub"><span>增值税费</span><b>{fees ? moneyPair(fees.vat, fx) : "—"}</b></div>
                <div className="ms-line sub"><span>关税</span><b>{fees ? moneyPair(fees.tariff, fx) : "—"}</b></div>
              </>
            ) : null}
            <div className="ms-line"><span>产品采购价</span><b>{fees ? moneyPair(fees.cost, fx) : "—"}</b></div>
            <div className="ms-line"><span>其他费用</span><b>{fees ? moneyPair(fees.other, fx) : "—"}</b></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
