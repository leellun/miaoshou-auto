import { useEffect, useState } from "react";
import { api } from "./api";

const FIELDS = ["startWeight", "liftPrice", "continuePrice10g", "buyerPayFreight"];

export default function FreightTable({ notify }) {
  const [rows, setRows] = useState([]);
  const [table, setTable] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api("/api/freight-table").then((data) => {
      setRows(data.rows || []);
      setTable(data.table || {});
    }).catch((err) => notify?.(err.message));
  }, []);

  function patch(site, key, value) {
    setTable((prev) => ({
      ...prev,
      [site]: { ...(prev[site] || {}), [key]: value },
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const body = {};
      for (const row of rows) {
        const item = table[row.site] || {};
        body[row.site] = {};
        for (const key of FIELDS) body[row.site][key] = item[key];
      }
      const data = await api("/api/freight-table", { method: "PUT", body: { table: body } });
      setTable(data.table || body);
      notify?.("跨境运费已保存");
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
          <h1>跨境运费设置</h1>
          <p>按国家填写官方跨境物流小包：起始重量（克）、起重价格、每 10g 续重价、买家支付运费。金额用对应国家币种，国家不可改。</p>
        </div>
        <button className="btn primary" type="button" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存运费"}</button>
      </div>
      <div className="card table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>国家</th>
              <th>起始重量 (g)</th>
              <th>起重价格</th>
              <th>续重价格(10g)</th>
              <th>买家支付运费</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const item = table[row.site] || {};
              const currency = row.currency || "";
              return (
                <tr key={row.site}>
                  <td className="nowrap">{row.name} / {row.site}</td>
                  <td>
                    <div className="ms-suffix" style={{ maxWidth: 180 }}>
                      <input type="number" step="1" min="0" value={item.startWeight ?? ""} onChange={(e) => patch(row.site, "startWeight", e.target.value)} />
                      <span>g</span>
                    </div>
                  </td>
                  <td>
                    <div className="ms-suffix" style={{ maxWidth: 180 }}>
                      <input type="number" step="0.01" min="0" value={item.liftPrice ?? ""} onChange={(e) => patch(row.site, "liftPrice", e.target.value)} />
                      <span>{currency}</span>
                    </div>
                  </td>
                  <td>
                    <div className="ms-suffix" style={{ maxWidth: 180 }}>
                      <input type="number" step="0.01" min="0" value={item.continuePrice10g ?? ""} onChange={(e) => patch(row.site, "continuePrice10g", e.target.value)} />
                      <span>{currency}</span>
                    </div>
                  </td>
                  <td>
                    <div className="ms-suffix" style={{ maxWidth: 180 }}>
                      <input type="number" step="0.01" min="0" value={item.buyerPayFreight ?? ""} onChange={(e) => patch(row.site, "buyerPayFreight", e.target.value)} />
                      <span>{currency}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <div className="empty-note">正在加载跨境运费…</div>}
      </div>
    </div>
  );
}
