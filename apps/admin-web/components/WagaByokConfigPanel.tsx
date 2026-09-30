"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type Config = { enabled: boolean; revision: number; migration_required: boolean };
export function WagaByokConfigPanel({ token, userId }: { token: string; userId: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true); setError("");
    try {
      const next = await apiRequest<Config>(`/admin/users/${encodeURIComponent(userId)}/waga-byok`, { signal }, token);
      if (!signal?.aborted) { setConfig(next); setEnabled(next.enabled); }
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "读取开关失败"); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, [token, userId]);
  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);
  return <section className="section-card client-runtime-config-card">
    <header><div><span className="kicker">OPTIONAL PROVIDER</span><h2>WagaAI 用户自备 Key</h2><p>仅对此用户授权（{userId}），默认关闭，不影响其他用户；需要用户主动选择自备 Key 模式。</p></div><span className={`status ${config?.enabled ? "good" : "warn"}`}>{config?.enabled ? "已开放" : "未开放"}</span></header>
    <form className="client-runtime-form" onSubmit={async e => {
      e.preventDefault(); if (!config || busy) return;
      setBusy(true); setError(""); setNotice("");
      try {
        const next = await apiRequest<Config>(`/admin/users/${encodeURIComponent(userId)}/waga-byok`, { method: "PATCH", body: JSON.stringify({ enabled, revision: config.revision }) }, token);
        setConfig(next); setEnabled(next.enabled); setNotice("已保存。客户端定时刷新入口，新提交请求会重新校验；已提交任务仍可查询原结果。");
      } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
      finally { setBusy(false); }
    }}>
      <label className={`client-runtime-source ${enabled ? "selected" : ""}`}><input type="checkbox" checked={enabled} disabled={busy || !config || config.migration_required} onChange={e => setEnabled(e.target.checked)} /><span><strong>允许此用户配置 WagaAI Key</strong><small>关闭后隐藏配置入口并阻止新的自备 Key 请求。原有平台模型、积分和充值功能不变；用户 Key 不会上传到本服务端。</small></span></label>
      <div className="client-runtime-actions"><button className="primary" disabled={busy || !config || config.migration_required}>{busy ? "处理中…" : "保存 WagaAI 开关"}</button><button className="secondary" type="button" disabled={busy} onClick={() => void load()}>重新读取</button></div>
      {config?.migration_required && <div className="form-error" role="alert">请先经审核部署数据库迁移 064；当前按关闭处理，不影响原有功能。</div>}
      {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="form-success" role="status">{notice}</div>}
    </form>
  </section>;
}
