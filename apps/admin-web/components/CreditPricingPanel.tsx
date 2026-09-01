"use client";

import { FormEvent, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

export type CreditSyncReport = {
  at: string; enabled: boolean; cny_per_credit: number; updated_count: number; unchanged_count: number; skipped_count: number;
  errors: string[];
  items: { model_id: string; model_code: string; model_alias: string; provider_name: string; resolution: string;
    billing_unit: string; previous_credits: number; credits: number | null; price_cny: number | null;
    channel: string; parameters: Record<string, string>; status: string; reason: string }[];
};
type PricingConfig = {
  cny_per_credit: number; auto_sync: boolean; revision: number;
  last_sync_at: string | null; last_sync_report: CreditSyncReport | null;
};

export function CreditPricingPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<PricingConfig | null>(null);
  const [ratio, setRatio] = useState("0.1");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<CreditSyncReport | null>(null);
  function apply(value: PricingConfig) {
    setConfig(value); setRatio(String(value.cny_per_credit)); setEnabled(value.auto_sync); setReport(value.last_sync_report);
  }
  useEffect(() => {
    let active = true;
    apiRequest<PricingConfig>("/admin/configs/credit-pricing", {}, token).then((value) => { if (active) apply(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "积分比例读取失败"); });
    return () => { active = false; };
  }, [token]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<{ config: PricingConfig; report: CreditSyncReport | null }>("/admin/configs/credit-pricing", {
        method: "PATCH", body: JSON.stringify({ cny_per_credit: ratio, auto_sync: enabled, revision: config.revision }),
      }, token);
      apply(result.config);
      if (result.report) setReport(result.report);
      setMessage(enabled ? "比例已保存，模型积分更新结果见下方。" : "比例已保存，自动更新已关闭；现有模型积分保持不变。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "比例保存失败"); }
    finally { setBusy(false); }
  }
  async function sync() {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<CreditSyncReport>("/admin/configs/credit-pricing/sync", { method: "POST" }, token);
      setReport(result); setMessage("已按保存的比例重新查询实时价格，处理结果见下方。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "模型积分更新失败"); }
    finally { setBusy(false); }
  }
  const dirty = !!config && (Number(ratio) !== config.cny_per_credit || enabled !== config.auto_sync);
  return <section className="section-card credit-pricing-config">
    <header><div><span className="kicker">CREDIT PRICING</span><h2>积分与人民币比例</h2><p>根据 WagaAI 实时最低可用价格，更新大模型积分定价。</p></div></header>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    {!config ? <div className="loading-card">{error ? "请刷新页面重新读取配置" : "正在读取积分比例…"}</div> : <form onSubmit={save}>
      <div className="credit-ratio-controls"><label>1 积分对应人民币（元）<input type="number" required min="0.000001" max="1000000" step="0.000001" value={ratio} disabled={busy} onChange={(event) => setRatio(event.target.value)} /></label>
        <div className="credit-ratio-example">{Number(ratio) > 0 ? <>1 积分 = ¥{Number(ratio)}<small>1 元 ≈ {(1 / Number(ratio)).toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 积分</small></> : "请输入大于 0 的比例"}</div>
      </div>
      <label className="credit-auto-sync"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />启用按实时价格自动更新模型积分</label>
      <p className="supplier-pricing-note">WagaAI：1 算力 = 1 元。选择运行中且当前 API Key 可用渠道的最低可换算价格；基础积分 = 人民币价格 ÷ 每积分金额，向上取整，最低 1 积分。图片按分辨率计每次基础积分，视频计每秒基础积分；用户最终单价还需乘以上方对应类型系数。</p>
      <p className="supplier-pricing-note">开启后，保存比例会同步已接入的启用供应商；在 AI 供应商页面查询/刷新实时价格也会更新积分。不进行定时后台刷新，不影响已创建任务、用户现有余额或充值套餐。按 Token 计费且无用量换算规则、不可用或参数不匹配的档位保留原积分，见下方结果。</p>
      <div className="inline-actions credit-pricing-actions"><button className="primary" disabled={busy}>{busy ? "处理中…" : enabled ? "保存比例并更新模型积分" : "保存比例"}</button>
        <button type="button" className="secondary" disabled={busy || !config.auto_sync || dirty} onClick={() => void sync()}>刷新实时价并更新积分</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setError(""); apiRequest<PricingConfig>("/admin/configs/credit-pricing", {}, token).then(apply).catch((reason) => setError(reason instanceof Error ? reason.message : "读取失败")); }}>重新读取配置</button>
      </div>
      {dirty && <small className="supplier-pricing-note">有未保存的修改，请先保存。</small>}
    </form>}
    {report && <CreditSyncResults report={report} />}
  </section>;
}

export function CreditSyncResults({ report }: { report: CreditSyncReport }) {
  return <details className="credit-sync-results">
    <summary>{report.enabled ? `积分定价：更新 ${report.updated_count} 项，未变 ${report.unchanged_count} 项，跳过 ${report.skipped_count} 项` : "自动定价未启用，本次仅查询价格"}{report.errors.length > 0 && ` · ${report.errors.length} 条提示`}</summary>
    <p className="supplier-pricing-note">{new Date(report.at).toLocaleString("zh-CN", { hour12: false })} · 本次比例：1 积分 = ¥{report.cny_per_credit}。报价按最低参数组合计算，附加参考素材费用及更高档参数不计入此最低价。</p>
    {report.errors.map((error, index) => <div className="test-warning" key={index}>{error}</div>)}
    {!!report.items.length && <div className="supplier-price-table"><table><thead><tr><th>模型 / 分辨率</th><th>最低人民币价</th><th>基础积分（原 → 新）</th><th>渠道 / 说明</th></tr></thead><tbody>
      {report.items.map((item) => <tr key={`${item.model_id}:${item.resolution}`}><td>{item.provider_name} · {item.model_alias}<br /><code>{item.model_code}</code>{item.resolution && <><br />{item.resolution}</>}</td>
        <td>{item.price_cny === null ? "—" : `¥${item.price_cny}`} / {item.billing_unit === "PER_SECOND" ? "秒" : "次"}</td>
        <td>{item.previous_credits} → {item.credits ?? "保留原值"}<br />{item.status === "UPDATED" ? "已更新" : item.status === "UNCHANGED" ? "未变化" : "已跳过"}</td>
        <td>{item.channel}{item.reason && <p>{item.reason}</p>}{Object.keys(item.parameters).length > 0 && <small>{Object.entries(item.parameters).map(([key, value]) => `${key}=${value}`).join(" · ")}</small>}</td></tr>)}
    </tbody></table></div>}
  </details>;
}
