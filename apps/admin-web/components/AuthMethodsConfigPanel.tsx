"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type AuthMethodsConfig = {
  registration_enabled: boolean;
  email_enabled: boolean;
  phone_otp_enabled: boolean;
  phone_otp_available: boolean;
  wechat_enabled: boolean;
  revision: number;
  updated_at: string;
};

type AuthMethodsForm = Pick<AuthMethodsConfig, "registration_enabled" | "email_enabled" | "phone_otp_enabled" | "wechat_enabled">;
const emptyForm: AuthMethodsForm = { registration_enabled: true, email_enabled: true, phone_otp_enabled: false, wechat_enabled: true };

export function AuthMethodsConfigPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<AuthMethodsConfig | null>(null);
  const [form, setForm] = useState<AuthMethodsForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const apply = (result: AuthMethodsConfig) => {
    setConfig(result);
    setForm({ registration_enabled: result.registration_enabled, email_enabled: result.email_enabled, phone_otp_enabled: result.phone_otp_enabled, wechat_enabled: result.wechat_enabled });
  };
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<AuthMethodsConfig>("/admin/configs/auth-methods", { signal }, token);
      if (!signal?.aborted) apply(result);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "读取登录方式配置失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [token]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config || saving || (!form.email_enabled && !form.wechat_enabled)) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<AuthMethodsConfig>("/admin/configs/auth-methods", { method: "PATCH", body: JSON.stringify(form) }, token);
      apply(result);
      setMessage("登录与注册配置已保存，客户端下次打开登录界面时生效。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存登录方式配置失败");
    } finally { setSaving(false); }
  }

  const noneAvailableSelected = !form.email_enabled && !form.wechat_enabled;
  return <section className="section-card auth-method-config-card">
    <header><div><span className="kicker">CLIENT AUTHENTICATION</span><h2>客户端登录方式</h2><p>统一控制客户端能否创建新账户，以及登录界面显示哪些登录方式。</p></div><span className={`status ${form.registration_enabled ? "good" : "warn"}`}>{form.registration_enabled ? "开放注册" : "仅限登录"}</span></header>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    {loading && <div className="loading-card"><span className="spinner" />正在读取登录方式…</div>}
    <form onSubmit={save}>
      <label className={`client-registration-switch ${form.registration_enabled ? "selected" : ""}`}><input type="checkbox" checked={form.registration_enabled} disabled={!config || loading || saving} onChange={event => setForm({ ...form, registration_enabled: event.target.checked })} /><span><strong>允许客户端注册新账户</strong><small>{form.registration_enabled ? "已开启：邮箱和微信首次使用时可以创建账户；邮箱注册可选填邀请码。" : "已关闭：客户端只允许已有账户登录，注册接口也会同步关闭。"}</small></span><em>{form.registration_enabled ? "已开启" : "已关闭"}</em></label>
      <fieldset className="auth-method-options" disabled={!config || loading || saving}>
        <label className={form.email_enabled ? "selected" : ""}><input type="checkbox" checked={form.email_enabled} onChange={event => setForm({ ...form, email_enabled: event.target.checked })} /><span><strong>邮箱登录方式</strong><small>{form.registration_enabled ? "新用户通过验证码注册，已有用户使用邮箱和密码登录。" : "仅允许已有用户使用邮箱和密码登录。"}</small></span></label>
        <label className="unavailable"><input type="checkbox" checked={false} disabled /><span><strong>手机验证码注册登录</strong><small>短信服务暂未接入，当前不能启用，也不会在客户端显示。</small></span><em>暂不可用</em></label>
        <label className={form.wechat_enabled ? "selected" : ""}><input type="checkbox" checked={form.wechat_enabled} onChange={event => setForm({ ...form, wechat_enabled: event.target.checked })} /><span><strong>微信扫码登录</strong><small>{form.registration_enabled ? "首次扫码可自动创建账户；微信方式不要求填写邀请码。" : "仅已绑定微信身份的账户可以扫码登录。"}</small></span></label>
      </fieldset>
      {noneAvailableSelected && <div className="form-error" role="alert">至少需要启用一种当前可用的登录方式。</div>}
      <div className="auth-method-actions"><button className="primary" disabled={!config || loading || saving || noneAvailableSelected}>{saving ? "保存中…" : "保存登录方式"}</button><button type="button" className="secondary" disabled={loading || saving} onClick={() => void load()}>重新读取</button>{config && <small>最近更新：{new Date(config.updated_at).toLocaleString("zh-CN", { hour12: false })}</small>}</div>
    </form>
  </section>;
}
