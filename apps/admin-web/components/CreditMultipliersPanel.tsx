"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

const types = { TEXT_GENERATION: "文本生成", VIDEO_UNDERSTANDING: "视频理解", IMAGE_GENERATION: "图片生成", VIDEO_GENERATION: "视频生成" } as const;
type Capability = keyof typeof types;
type Config = { revision: number; multipliers: Record<Capability, number> };
const defaults: Record<Capability, string> = { TEXT_GENERATION: "1", VIDEO_UNDERSTANDING: "1", IMAGE_GENERATION: "1", VIDEO_GENERATION: "1" };

export function CreditMultipliersPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [form, setForm] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const apply = (result: Config) => {
    setConfig(result);
    setForm(Object.fromEntries(Object.keys(types).map((key) => [key, String(result.multipliers[key as Capability])])) as typeof defaults);
  };
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const result = await apiRequest<Config>("/admin/configs/credit-multipliers", { signal }, token); if (!signal?.aborted) { apply(result); setError(""); } }
    catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "积分系数读取失败"); }
  }, [token]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!config || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<Config>("/admin/configs/credit-multipliers", { method: "PATCH", body: JSON.stringify({ revision: config.revision, multipliers: form }) }, token);
      apply(result); setMessage("四类模型积分系数已保存，新建任务和客户端重新读取的模型价格立即使用新系数。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "积分系数保存失败"); }
    finally { setBusy(false); }
  }
  return <section className="section-card credit-pricing-config">
    <header><div><span className="kicker">MODEL CREDIT MULTIPLIERS</span><h2>大模型积分系数</h2><p>四类模型分别设置乘数，默认均为 1。</p></div></header>
    {error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}
    <form onSubmit={save}><div className="credit-multiplier-grid">{(Object.keys(types) as Capability[]).map((capability) => <label key={capability}>{types[capability]}系数
      <input type="number" min="0.000001" max="1000" step="0.000001" required disabled={!config || busy} value={form[capability]} onChange={(event) => setForm({ ...form, [capability]: event.target.value })} />
      <small>基础 10 积分 × {form[capability] || "—"} = {Number(form[capability]) > 0 ? Number((10 * Number(form[capability])).toFixed(6)) : "—"} 积分</small>
    </label>)}</div>
      <p className="supplier-pricing-note">最终单价 = 模型基础积分 × 对应类型系数。图片使用所选分辨率的每次价格；视频使用所选分辨率的每秒价格，再乘视频秒数。系数独立生效，无需开启实时自动定价；手工定价的文本和视频理解模型同样适用。</p>
      <p className="supplier-pricing-note">支持小数系数和小数积分，最多保留 6 位小数，超出部分向上取到最小积分精度，不向上取整为整数。仅影响新建任务，不修改基础定价、历史任务、用户余额或充值套餐。</p>
      <div className="credit-multiplier-actions"><button className="primary" disabled={!config || busy}>{busy ? "保存中…" : "保存积分系数"}</button><button type="button" className="secondary" disabled={busy} onClick={() => void load()}>重新读取</button></div>
    </form>
  </section>;
}
