"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type ClientRuntimeConfig = {
  recommended_video_concurrency: number;
  configured_video_concurrency: number | null;
  environment_default_video_concurrency: number;
  source: "database" | "environment";
  revision: number;
  updated_at: string;
};

export function ClientRuntimeConfigPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<ClientRuntimeConfig | null>(null);
  const [value, setValue] = useState("4");
  const [inheritEnvironment, setInheritEnvironment] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const apply = useCallback((result: ClientRuntimeConfig) => {
    setConfig(result);
    setValue(String(result.recommended_video_concurrency));
    setInheritEnvironment(result.configured_video_concurrency === null);
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<ClientRuntimeConfig>("/admin/configs/client-runtime", { signal }, token);
      if (!signal?.aborted) apply(result);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "读取客户端运行配置失败");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [apply, token]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config || saving) return;
    const concurrency = Number(value);
    if (!inheritEnvironment && (!value.trim() || !Number.isSafeInteger(concurrency) || concurrency < 0)) {
      setError("视频并发数必须是非负整数，填写 0 表示不限制。");
      return;
    }
    setSaving(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<ClientRuntimeConfig>("/admin/configs/client-runtime", {
        method: "PATCH",
        body: JSON.stringify({
          recommended_video_concurrency: inheritEnvironment ? null : concurrency,
          revision: config.revision,
        }),
      }, token);
      apply(result);
      setMessage("配置已保存，新启动的自动工作流会立即使用新的并发设置。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存客户端运行配置失败"); }
    finally { setSaving(false); }
  }

  const effective = inheritEnvironment ? config?.environment_default_video_concurrency ?? 4 : Number(value);
  const status = effective === 0 ? "不限制并发" : `并发 ${Number.isSafeInteger(effective) && effective >= 0 ? effective : "—"}`;
  return <section className="section-card client-runtime-config-card">
    <header><div><span className="kicker">CLIENT RUNTIME</span><h2>自动工作流视频并发</h2><p>控制每个客户端在一键自动制作时可以同时提交多少个视频任务。</p></div>{config && <span className={`status ${effective === 0 ? "warn" : "good"}`}>{status}</span>}</header>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    {loading ? <div className="loading-card"><span className="spinner" />正在读取客户端运行配置…</div> : config && <form className="client-runtime-form" onSubmit={save}>
      <label className={`client-runtime-source ${inheritEnvironment ? "selected" : ""}`}><input type="checkbox" checked={inheritEnvironment} disabled={saving} onChange={event => setInheritEnvironment(event.target.checked)} /><span><strong>跟随服务器环境变量</strong><small>当前环境默认值为 {config.environment_default_video_concurrency === 0 ? "0（不限制）" : config.environment_default_video_concurrency}。取消勾选后使用下方数据库配置。</small></span></label>
      <label>推荐视频并发数<input type="number" min="0" step="1" inputMode="numeric" value={value} disabled={saving || inheritEnvironment} onChange={event => setValue(event.target.value)} required={!inheritEnvironment} /><small><strong>0</strong> 表示客户端不设置并发上限；正整数表示同时生成的视频任务数，不设置人为上限。</small></label>
      <div className="client-runtime-summary"><span>当前实际生效</span><strong>{config.recommended_video_concurrency === 0 ? "不限制" : `${config.recommended_video_concurrency} 个并发任务`}</strong><small>来源：{config.source === "database" ? "管理后台数据库配置" : "服务器环境变量"}。已运行的工作流保持原并发，新启动的工作流使用新值。</small></div>
      <div className="client-runtime-actions"><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存运行配置"}</button><button className="secondary" type="button" disabled={saving} onClick={() => void load()}>重新读取</button>{config.updated_at && <small>最近更新：{new Date(config.updated_at).toLocaleString("zh-CN", { hour12: false })}</small>}</div>
    </form>}
  </section>;
}
