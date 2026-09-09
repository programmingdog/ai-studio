"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { type ProductBrand, useProductBrand } from "@/components/ProductBrand";

export function ProductBrandConfigPanel({ token }: { token: string }) {
  const { setProductBrand } = useProductBrand();
  const [config, setConfig] = useState<ProductBrand | null>(null);
  const [form, setForm] = useState({ chinese_name: "逐梦帧", english_name: "逐梦帧" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const apply = useCallback((result: ProductBrand) => {
    setConfig(result);
    setForm({ chinese_name: result.chinese_name, english_name: result.english_name });
    setProductBrand(result);
  }, [setProductBrand]);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<ProductBrand>("/admin/configs/product-brand", { signal }, token);
      if (!signal?.aborted) apply(result);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "读取产品名称失败");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [apply, token]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config || saving || !form.chinese_name.trim() || !form.english_name.trim()) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<ProductBrand>("/admin/configs/product-brand", { method: "PATCH", body: JSON.stringify(form) }, token);
      apply(result);
      setMessage("产品名称已保存，后台和客户端下次读取配置时生效。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存产品名称失败"); }
    finally { setSaving(false); }
  }

  return <section className="section-card product-brand-config-card">
    <header><div><span className="kicker">PRODUCT BRAND</span><h2>产品名称</h2><p>中文界面使用中文名，其他界面语言使用英文名。</p></div><span className="status good">品牌配置</span></header>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    {loading && <div className="loading-card"><span className="spinner" />正在读取产品名称…</div>}
    <form className="product-brand-form" onSubmit={save}>
      <fieldset disabled={!config || loading || saving}>
        <label>产品中文名<input value={form.chinese_name} maxLength={32} onChange={event => setForm({ ...form, chinese_name: event.target.value })} placeholder="例如：逐梦帧" required /><small>用于简体中文和繁体中文界面。</small></label>
        <label>产品英文名<input value={form.english_name} maxLength={64} onChange={event => setForm({ ...form, english_name: event.target.value })} placeholder="例如：逐梦帧" required /><small>用于英语及其他非中文界面。</small></label>
      </fieldset>
      <div className="product-brand-actions"><button className="primary" disabled={!config || loading || saving}>{saving ? "保存中…" : "保存产品名称"}</button><button className="secondary" type="button" disabled={loading || saving} onClick={() => void load()}>重新读取</button>{config?.updated_at && <small>最近更新：{new Date(config.updated_at).toLocaleString("zh-CN", { hour12: false })}</small>}</div>
    </form>
  </section>;
}
