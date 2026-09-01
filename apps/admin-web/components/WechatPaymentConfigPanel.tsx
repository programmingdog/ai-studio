"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type WechatPaymentConfig = {
  id: string;
  merchant_id: string;
  payment_notify_url: string;
  merchant_key_configured: boolean;
  merchant_key_hint: string;
  certificate_configured: boolean;
  certificate_filename: string | null;
  certificate_uploaded_at: string | null;
  private_key_configured: boolean;
  private_key_filename: string | null;
  private_key_uploaded_at: string | null;
  platform_certificate_configured: boolean;
  platform_certificate_filename: string | null;
  platform_certificate_serial: string | null;
  platform_certificate_uploaded_at: string | null;
  official_account_name: string;
  app_id: string;
  app_secret_configured: boolean;
  app_secret_hint: string;
  open_platform_app_id: string;
  open_platform_app_secret_configured: boolean;
  open_platform_app_secret_hint: string;
  open_platform_redirect_uri: string;
  status: string;
  updated_at: string;
};

function errorMessage(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
function formatDate(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未上传"; }

export function WechatPaymentConfigPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<WechatPaymentConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => apiRequest<WechatPaymentConfig>("/admin/configs/wechat-payment", {}, token).then(setConfig).catch((reason) => setError(errorMessage(reason, "读取微信支付配置失败"))), [token]);
  useEffect(() => { void load(); }, [load]);
  return <>
    <section className="section-card payment-config-card">
      <header><div><span className="kicker">WECHAT PAYMENT</span><h2>微信支付配置</h2><p>商户密钥、AppSecret 和证书均加密保存在服务器，不会返回浏览器。</p></div><div className="record-header-actions">{config && <span className={`status ${config.status === "ACTIVE" ? "good" : "bad"}`}>{config.status}</span>}<button className="primary" disabled={!config} onClick={() => setEditing(true)}>{config?.merchant_id ? "编辑配置" : "开始配置"}</button></div></header>
      {error && <div className="form-error">{error}</div>}
      {!config ? !error && <div className="loading-card"><span className="spinner" />正在读取微信支付配置…</div> : <div className="payment-config-grid">
        <article><span>商户信息</span><strong>{config.merchant_id || "未配置商户号"}</strong><small>{config.merchant_key_configured ? `APIv3 Key：${config.merchant_key_hint}` : "APIv3 Key 未配置"}</small></article>
        <article><span>商户证书</span><strong>{config.certificate_filename || "cert 证书未上传"}</strong><small>{formatDate(config.certificate_uploaded_at)}</small></article>
        <article><span>私钥证书</span><strong>{config.private_key_filename || "key 证书未上传"}</strong><small>{formatDate(config.private_key_uploaded_at)}</small></article>
        <article><span>微信支付平台证书</span><strong>{config.platform_certificate_filename || "平台证书未上传"}</strong><small>{config.platform_certificate_serial ? `序列号 ${config.platform_certificate_serial}` : formatDate(config.platform_certificate_uploaded_at)}</small></article>
        <article><span>公众号</span><strong>{config.official_account_name || "未配置公众号"}</strong><small>{config.app_id || "AppID 未配置"}{config.app_secret_configured ? ` · ${config.app_secret_hint}` : " · AppSecret 未配置"}</small></article>
        <article><span>开放平台扫码登录</span><strong>{config.open_platform_app_id || "网站应用 AppID 未配置"}</strong><small>{config.open_platform_app_secret_configured ? `${config.open_platform_app_secret_hint} · ${config.open_platform_redirect_uri || "回调未配置"}` : "AppSecret 未配置"}</small></article>
        <article><span>支付回调</span><strong>{config.payment_notify_url || "未配置 HTTPS 回调"}</strong><small>微信支付成功后自动、幂等发放积分</small></article>
      </div>}
    </section>
    {editing && config && <WechatPaymentConfigModal token={token} config={config} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await load(); }} />}
  </>;
}

function WechatPaymentConfigModal({ token, config, onClose, onSaved }: { token: string; config: WechatPaymentConfig; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ merchant_id: config.merchant_id, payment_notify_url: config.payment_notify_url, merchant_key: "", official_account_name: config.official_account_name, app_id: config.app_id, app_secret: "", open_platform_app_id: config.open_platform_app_id, open_platform_app_secret: "", open_platform_redirect_uri: config.open_platform_redirect_uri, status: config.status });
  const [certificate, setCertificate] = useState<{ filename: string; content: string } | null>(null);
  const [privateKey, setPrivateKey] = useState<{ filename: string; content: string } | null>(null);
  const [platformCertificate, setPlatformCertificate] = useState<{ filename: string; content: string } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const readFile = async (event: ChangeEvent<HTMLInputElement>, type: "certificate" | "privateKey" | "platformCertificate") => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 512 * 1024) { setError("证书文件不能超过 512KB"); event.target.value = ""; return; }
    try {
      const next = { filename: file.name, content: await file.text() };
      if (type === "certificate") setCertificate(next);
      else if (type === "privateKey") setPrivateKey(next);
      else setPlatformCertificate(next);
      setError("");
    } catch { setError("无法读取证书文件"); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await apiRequest("/admin/configs/wechat-payment", { method: "PATCH", body: JSON.stringify({
        ...form,
        merchant_key: form.merchant_key || undefined,
        app_secret: form.app_secret || undefined,
        certificate_content: certificate?.content,
        certificate_filename: certificate?.filename,
        private_key_content: privateKey?.content,
        private_key_filename: privateKey?.filename,
        platform_certificate_content: platformCertificate?.content,
        platform_certificate_filename: platformCertificate?.filename,
      }) }, token);
      await onSaved();
    } catch (reason) { setError(errorMessage(reason, "保存微信支付配置失败")); }
    finally { setSaving(false); }
  };
  const firstSetup = !config.merchant_key_configured || !config.app_secret_configured || !config.certificate_configured || !config.private_key_configured || !config.platform_certificate_configured || !config.open_platform_app_secret_configured;
  return <div className="modal-backdrop"><form className="modal model-modal payment-config-modal" onSubmit={submit}>
    <header><div><span className="kicker">SECURE PAYMENT CONFIG</span><h2>配置微信支付</h2><p>敏感字段保存后只显示脱敏状态，无法从后台下载或查看原文。</p></div><button type="button" onClick={onClose}>×</button></header>
    <div className="test-warning">{firstSetup ? "首次配置需要填写全部密钥，并上传商户 cert、商户私钥与微信支付平台证书。" : "密钥和证书留空时会保留服务器上的现有配置。"}</div>
    <section className="form-section"><header><strong>微信支付商户</strong><small>用于 Native 支付下单、响应验签和回调解密</small></header><div className="two-columns"><label>商户号<input inputMode="numeric" value={form.merchant_id} onChange={(event) => setForm({ ...form, merchant_id: event.target.value })} placeholder="微信支付商户号" required /></label><label>APIv3 密钥（32 字节）<input type="password" autoComplete="new-password" value={form.merchant_key} onChange={(event) => setForm({ ...form, merchant_key: event.target.value })} placeholder={config.merchant_key_configured ? `已配置 ${config.merchant_key_hint}，留空保留` : "请输入 32 字节 APIv3 密钥"} required={!config.merchant_key_configured} /></label></div><label>支付通知地址<input type="url" value={form.payment_notify_url} onChange={(event) => setForm({ ...form, payment_notify_url: event.target.value })} placeholder="https://api.example.com/api/v1/payments/wechat/notify" required /></label><div className="two-columns"><label className="file-field">商户 cert 证书<input type="file" accept=".pem,.crt,.cer" onChange={(event) => void readFile(event, "certificate")} required={!config.certificate_configured} /><span>{certificate?.filename || config.certificate_filename || "选择 apiclient_cert.pem"}</span></label><label className="file-field">商户 key 私钥<input type="file" accept=".pem,.key" onChange={(event) => void readFile(event, "privateKey")} required={!config.private_key_configured} /><span>{privateKey?.filename || config.private_key_filename || "选择 apiclient_key.pem"}</span></label></div><label className="file-field">微信支付平台证书（用于验签）<input type="file" accept=".pem,.crt,.cer" onChange={(event) => void readFile(event, "platformCertificate")} required={!config.platform_certificate_configured} /><span>{platformCertificate?.filename || config.platform_certificate_filename || "选择微信支付平台证书 PEM"}</span></label></section>
    <section className="form-section"><header><strong>公众号信息</strong><small>Native 支付下单使用公众号 AppID</small></header><div className="two-columns"><label>公众号名称<input value={form.official_account_name} onChange={(event) => setForm({ ...form, official_account_name: event.target.value })} required /></label><label>公众号 AppID<input value={form.app_id} onChange={(event) => setForm({ ...form, app_id: event.target.value })} placeholder="wx..." required /></label></div><div className="two-columns"><label>公众号 AppSecret<input type="password" autoComplete="new-password" value={form.app_secret} onChange={(event) => setForm({ ...form, app_secret: event.target.value })} placeholder={config.app_secret_configured ? `已配置 ${config.app_secret_hint}，留空保留` : "请输入公众号 AppSecret"} required={!config.app_secret_configured} /></label><label>配置状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="DISABLED">停用</option><option value="ACTIVE">启用</option></select></label></div></section>
    <section className="form-section"><header><strong>微信开放平台网站应用</strong><small>PC 客户端微信扫码注册与登录使用，和公众号配置相互独立</small></header><div className="two-columns"><label>网站应用 AppID<input value={form.open_platform_app_id} onChange={(event) => setForm({ ...form, open_platform_app_id: event.target.value })} placeholder="wx..." required /></label><label>网站应用 AppSecret<input type="password" autoComplete="new-password" value={form.open_platform_app_secret} onChange={(event) => setForm({ ...form, open_platform_app_secret: event.target.value })} placeholder={config.open_platform_app_secret_configured ? `已配置 ${config.open_platform_app_secret_hint}，留空保留` : "请输入开放平台 AppSecret"} required={!config.open_platform_app_secret_configured} /></label></div><label>扫码登录回调地址<input type="url" value={form.open_platform_redirect_uri} onChange={(event) => setForm({ ...form, open_platform_redirect_uri: event.target.value })} placeholder="https://api.example.com/api/v1/auth/wechat/callback" required /></label></section>
    {error && <div className="form-error">{error}</div>}
    <footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "加密保存中…" : "保存微信支付配置"}</button></footer>
  </form></div>;
}
