"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type IpRule = {
  id: string; cidr: string; address_family: number; prefix_length: number; note: string;
  enabled: boolean; created_at: string; updated_at: string;
};
type RuleList = { current_ip: string | null; rules: IpRule[] };

export function IpAccessRulesPanel({ token }: { token: string }) {
  const [data, setData] = useState<RuleList | null>(null);
  const [cidr, setCidr] = useState("");
  const [note, setNote] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const result = await apiRequest<RuleList>("/admin/configs/ip-access-rules", { signal }, token);
      if (!signal?.aborted) setData(result);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "读取 IP 风控规则失败");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [token]);

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!cidr.trim() || busyId) return;
    setBusyId("new"); setError(""); setMessage("");
    try {
      await apiRequest("/admin/configs/ip-access-rules", { method: "POST", body: JSON.stringify({ cidr, note, enabled }) }, token);
      setCidr(""); setNote(""); setEnabled(true); setMessage("IP 风控规则已添加并生效。");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "添加 IP 风控规则失败"); }
    finally { setBusyId(""); }
  }

  async function toggle(rule: IpRule) {
    setBusyId(rule.id); setError(""); setMessage("");
    try {
      await apiRequest(`/admin/configs/ip-access-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ cidr: rule.cidr, note: rule.note, enabled: !rule.enabled }) }, token);
      setMessage(`规则 ${rule.cidr} 已${rule.enabled ? "停用" : "启用"}。`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "更新 IP 风控规则失败"); }
    finally { setBusyId(""); }
  }

  async function remove(rule: IpRule) {
    if (!window.confirm(`确定删除 IP 风控规则 ${rule.cidr} 吗？`)) return;
    setBusyId(rule.id); setError(""); setMessage("");
    try {
      await apiRequest(`/admin/configs/ip-access-rules/${rule.id}`, { method: "DELETE" }, token);
      setMessage(`规则 ${rule.cidr} 已删除。`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除 IP 风控规则失败"); }
    finally { setBusyId(""); }
  }

  return <section className="section-card ip-access-card">
    <header><div><span className="kicker">NETWORK RISK CONTROL</span><h2>IP 访问限制</h2><p>启用的单个 IP 或 CIDR 网段将无法注册、登录或访问任何服务端 API。</p></div><span className="record-count">{data?.rules.length || 0} 条规则</span></header>
    <div className="ip-access-current"><strong>当前管理端 IP</strong><code>{data?.current_ip || "未识别"}</code><small>系统不允许启用会立即拦截当前 IP 的规则，避免误锁后台。</small></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    <form className="ip-access-form" onSubmit={create}>
      <label>IP 地址或 CIDR 网段<input value={cidr} maxLength={64} onChange={event => setCidr(event.target.value)} placeholder="例如：203.0.113.8 或 203.0.113.0/24" required /><small>同时支持 IPv4 和 IPv6；主机地址会自动规范为 /32 或 /128。</small></label>
      <label>备注<input value={note} maxLength={200} onChange={event => setNote(event.target.value)} placeholder="例如：异常批量注册来源" /></label>
      <div className="ip-access-submit">
        <label className="ip-access-enable"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>添加后立即启用</span></label>
        <button className="primary" disabled={busyId === "new"}>{busyId === "new" ? "添加中…" : "添加风控规则"}</button>
      </div>
    </form>
    {loading ? <div className="loading-card"><span className="spinner" />正在读取 IP 风控规则…</div> :
      <div className="table-scroll ip-access-table"><table><thead><tr><th>IP / 网段</th><th>类型</th><th>备注</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>
        {!data?.rules.length && <tr><td className="empty-row" colSpan={6}>暂未添加 IP 风控规则</td></tr>}
        {data?.rules.map(rule => <tr key={rule.id}><td><code>{rule.cidr}</code></td><td>IPv{rule.address_family}</td><td className="ip-access-note">{rule.note || "—"}</td><td><span className={`status ${rule.enabled ? "bad" : "warn"}`}>{rule.enabled ? "拦截中" : "已停用"}</span></td><td>{new Date(rule.updated_at).toLocaleString("zh-CN", { hour12: false })}</td><td><div className="table-actions"><button className="secondary" disabled={Boolean(busyId)} onClick={() => void toggle(rule)}>{rule.enabled ? "停用" : "启用"}</button><button className="danger-button" disabled={Boolean(busyId)} onClick={() => void remove(rule)}>删除</button></div></td></tr>)}
      </tbody></table></div>}
  </section>;
}
