import { useEffect, useState } from "react";
import { api } from "./api";

export default function FxRates({ notify }) {
  const [rows, setRows] = useState([]);
  const [rates, setRates] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api("/api/fx-rates").then((data) => {
      setRows(data.rows || []);
      setRates(data.rates || {});
    }).catch((err) => notify?.(err.message));
  }, []);

  function patch(currency, value) {
    setRates((prev) => ({ ...prev, [currency]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      const body = {};
      for (const row of rows) body[row.currency] = Number(rates[row.currency]);
      const data = await api("/api/fx-rates", { method: "PUT", body });
      setRates(data.rates || body);
      notify?.("汇率已保存");
    } catch (err) {
      notify?.(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>汇率设置</h1>
          <p>按 1 CNY ≈ 目标币种 填写，供定价试算把人民币换成站点币。留空或无效时用默认值。</p>
        </div>
        <button className="btn primary" type="button" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存汇率"}</button>
      </div>
      <div className="card table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>站点</th>
              <th>币种</th>
              <th>1 CNY ≈</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.currency}>
                <td>{row.name} / {row.site}</td>
                <td>{row.currency}</td>
                <td>
                  <div className="ms-suffix" style={{ maxWidth: 280 }}>
                    <input type="number" step="0.0001" min="0" value={rates[row.currency] ?? ""} onChange={(e) => patch(row.currency, e.target.value)} />
                    <span>{row.currency}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty-note">正在加载汇率…</div>}
      </div>
    </div>
  );
}
