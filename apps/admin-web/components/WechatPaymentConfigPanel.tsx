"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type WechatConfig = {
  id: string; merchant_id: string; payment_notify_url: string;
  merchant_key_configured: boolean; merchant_key_hint: string;
  certificate_configured: boolean; certificate_filename: string | null; certificate_uploaded_at: string | null;
  private_key_configured: boolean; private_key_filename: string | null; private_key_uploaded_at: string | null;
  platform_certificate_configured: boolean; platform_certificate_filename: string | null;
  platform_certificate_serial: string | null; platform_certificate_uploaded_at: string | null;
  wechatpay_public_key_configured: boolean; wechatpay_public_key_filename: string | null;
  wechatpay_public_key_id: string; wechatpay_public_key_uploaded_at: string | null;
  payment_verification_mode: "WECHATPAY_PUBLIC_KEY" | "PLATFORM_CERTIFICATE";
  official_account_name: string; app_id: string; app_secret_configured: boolean; app_secret_hint: string;
  official_account_token_configured: boolean; official_account_token_hint: string;
  official_account_encoding_aes_key_configured: boolean; official_account_encoding_aes_key_hint: string;
  official_account_callback_url: string; status: string; updated_at: string;
};

type Upload = { filename: string; base64: string };
function errorMessage(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
function formatDate(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未上传"; }
async function fileUpload(file: File): Promise<Upload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { filename: file.name, base64: btoa(binary) };
}

export function WechatPaymentConfigPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<WechatConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => apiRequest<WechatConfig>("/admin/configs/wechat-payment", {}, token).then(setConfig).catch((reason) => setError(errorMessage(reason, "读取微信配置失败"))), [token]);
  useEffect(() => { void load(); }, [load]);
  return <>
    <section className="section-card payment-config-card">
      <header><div><span className="kicker">WECHAT INTEGRATION</span><h2>微信公众号与微信支付</h2><p>公众号扫码登录和 Native 支付共用公众号 AppID；密钥及私钥加密保存且不会返回浏览器。</p></div><div className="record-header-actions">{config && <span className={`status ${config.status === "ACTIVE" ? "good" : "bad"}`}>{config.status}</span>}<button className="primary" disabled={!config} onClick={() => setEditing(true)}>{config?.merchant_id ? "编辑配置" : "开始配置"}</button></div></header>
      {error && <div className="form-error">{error}</div>}
      {!config ? !error && <div className="loading-card"><span className="spinner" />正在读取微信配置…</div> : <div className="payment-config-grid">
        <article><span>支付商户</span><strong>{config.merchant_id || "未配置商户号"}</strong><small>{config.merchant_key_configured ? `APIv3 Key：${config.merchant_key_hint}` : "APIv3 Key 未配置"}</small></article>
        <article><span>商户 API 证书</span><strong>{config.certificate_filename || "apiclient_cert.pem 未上传"}</strong><small>{config.private_key_filename || "apiclient_key.pem 未上传"}</small></article>
        <article><span>支付通知验签</span><strong>{config.payment_verification_mode === "WECHATPAY_PUBLIC_KEY" ? config.wechatpay_public_key_filename || "微信支付公钥未上传" : config.platform_certificate_filename || "微信支付平台证书未上传"}</strong><small>{config.payment_verification_mode === "WECHATPAY_PUBLIC_KEY" ? config.wechatpay_public_key_id || "公钥 ID 未配置" : config.platform_certificate_serial || "平台证书序列号未配置"}</small></article>
        <article><span>微信公众号</span><strong>{config.official_account_name || "未配置公众号"}</strong><small>{config.app_id || "AppID 未配置"}{config.app_secret_configured ? ` · ${config.app_secret_hint}` : " · AppSecret 未配置"}</small></article>
        <article><span>公众号事件接收</span><strong>{config.official_account_callback_url || "回调地址未配置"}</strong><small>{config.official_account_token_configured ? `Token：${config.official_account_token_hint}` : "Token 未配置"}{config.official_account_encoding_aes_key_configured ? " · 已启用消息加密" : " · 明文模式"}</small></article>
        <article><span>支付通知</span><strong>{config.payment_notify_url || "通知地址未配置"}</strong><small>支付成功后验签、解密并幂等发放积分</small></article>
      </div>}
    </section>
    {editing && config && <WechatConfigModal token={token} config={config} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await load(); }} />}
  </>;
}

function WechatConfigModal({ token, config, onClose, onSaved }: { token: string; config: WechatConfig; onClose: () => void; onSaved: () => Promise<void> }) {
  const origin = typeof window === "undefined" ? "https://你的域名" : window.location.origin;
  const [form, setForm] = useState({
    merchant_id: config.merchant_id, payment_notify_url: config.payment_notify_url || `${origin}/api/v1/payments/wechat/notify`, merchant_key: "",
    payment_verification_mode: config.payment_verification_mode || "PLATFORM_CERTIFICATE", wechatpay_public_key_id: config.wechatpay_public_key_id,
    official_account_name: config.official_account_name, app_id: config.app_id, app_secret: "", official_account_token: "",
    official_account_encoding_aes_key: "", official_account_callback_url: config.official_account_callback_url || `${origin}/api/v1/auth/wechat/events`, status: config.status,
  });
  const [certificate, setCertificate] = useState<Upload | null>(null);
  const [privateKey, setPrivateKey] = useState<Upload | null>(null);
  const [platformCertificate, setPlatformCertificate] = useState<Upload | null>(null);
  const [wechatpayPublicKey, setWechatpayPublicKey] = useState<Upload | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const readFile = async (event: ChangeEvent<HTMLInputElement>, type: "certificate" | "privateKey" | "platformCertificate" | "wechatpayPublicKey") => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 512 * 1024) { setError("密钥或证书文件不能超过 512KB"); event.target.value = ""; return; }
    try {
      const next = await fileUpload(file);
      if (type === "certificate") setCertificate(next);
      else if (type === "privateKey") setPrivateKey(next);
      else if (type === "platformCertificate") setPlatformCertificate(next);
      else setWechatpayPublicKey(next);
      setError("");
    } catch { setError("无法读取密钥或证书文件"); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await apiRequest("/admin/configs/wechat-payment", { method: "PATCH", body: JSON.stringify({
        ...form, merchant_key: form.merchant_key || undefined, app_secret: form.app_secret || undefined,
        official_account_token: form.official_account_token || undefined,
        official_account_encoding_aes_key: form.official_account_encoding_aes_key || undefined,
        certificate_base64: certificate?.base64, certificate_filename: certificate?.filename,
        private_key_base64: privateKey?.base64, private_key_filename: privateKey?.filename,
        platform_certificate_base64: platformCertificate?.base64, platform_certificate_filename: platformCertificate?.filename,
        wechatpay_public_key_base64: wechatpayPublicKey?.base64, wechatpay_public_key_filename: wechatpayPublicKey?.filename,
      }) }, token);
      await onSaved();
    } catch (reason) { setError(errorMessage(reason, "保存微信配置失败")); }
    finally { setSaving(false); }
  };
  const paymentVerifierRequired = form.payment_verification_mode === "WECHATPAY_PUBLIC_KEY"
    ? !config.wechatpay_public_key_configured && !wechatpayPublicKey
    : !config.platform_certificate_configured && !platformCertificate;
  const firstSetup = !config.merchant_key_configured || !config.app_secret_configured || !config.certificate_configured || !config.private_key_configured || paymentVerifierRequired || !config.official_account_token_configured;
  return <div className="modal-backdrop"><form className="modal model-modal payment-config-modal" onSubmit={submit}>
    <header><div><span className="kicker">SECURE WECHAT CONFIG</span><h2>配置微信公众号与微信支付</h2><p>保存后敏感字段只显示脱敏状态。证书上传支持 PEM 和 DER，商户证书会自动校验是否与私钥匹配。</p></div><button type="button" onClick={onClose}>×</button></header>
    <div className="test-warning">{firstSetup ? "首次配置需填写密钥、公众号服务器 Token，并上传商户证书、商户私钥及所选验签材料。" : "密钥和文件留空时保留服务器现有配置；共用商户号尚未统一迁移时请选择平台证书。"}</div>
    <section className="form-section"><header><strong>微信支付商户</strong><small>Native 下单使用商户私钥签名；平台证书或微信支付公钥用于验证 API 应答和支付通知</small></header>
      <div className="two-columns"><label>商户号<input inputMode="numeric" value={form.merchant_id} onChange={(event) => setForm({ ...form, merchant_id: event.target.value })} placeholder="微信支付商户号" required /></label><label>APIv3 密钥（32 字节）<input type="password" autoComplete="new-password" value={form.merchant_key} onChange={(event) => setForm({ ...form, merchant_key: event.target.value })} placeholder={config.merchant_key_configured ? `已配置 ${config.merchant_key_hint}，留空保留` : "请输入 32 字节 APIv3 密钥"} required={!config.merchant_key_configured} /></label></div>
      <label>支付通知地址<input type="url" value={form.payment_notify_url} onChange={(event) => setForm({ ...form, payment_notify_url: event.target.value })} required /></label>
      <div className="two-columns"><label className="file-field">商户 cert 证书（PEM/DER）<input type="file" accept=".pem,.crt,.cer" onChange={(event) => void readFile(event, "certificate")} required={!config.certificate_configured} /><span>{certificate?.filename || config.certificate_filename || "选择 apiclient_cert.pem"}</span></label><label className="file-field">商户 key 私钥（PEM）<input type="file" accept=".pem,.key" onChange={(event) => void readFile(event, "privateKey")} required={!config.private_key_configured} /><span>{privateKey?.filename || config.private_key_filename || "选择 apiclient_key.pem"}</span></label></div>
      <label>支付应答和通知验签方式<select value={form.payment_verification_mode} onChange={(event) => setForm({ ...form, payment_verification_mode: event.target.value as "PLATFORM_CERTIFICATE" | "WECHATPAY_PUBLIC_KEY" })}><option value="PLATFORM_CERTIFICATE">微信支付平台证书（当前共用商户号请选择此项）</option><option value="WECHATPAY_PUBLIC_KEY">微信支付公钥（所有项目完成迁移后使用）</option></select></label>
      {form.payment_verification_mode === "PLATFORM_CERTIFICATE" ? <label className="file-field">微信支付平台证书（PEM）<input type="file" accept=".pem,.crt,.cer" onChange={(event) => void readFile(event, "platformCertificate")} required={paymentVerifierRequired} /><span>{platformCertificate?.filename || config.platform_certificate_filename || "选择 wechatpay_证书序列号.pem"}</span></label> : <div className="two-columns"><label>微信支付公钥 ID<input value={form.wechatpay_public_key_id} onChange={(event) => setForm({ ...form, wechatpay_public_key_id: event.target.value })} placeholder="PUB_KEY_ID_..." required /><span className="field-hint">必须完整保留 PUB_KEY_ID_ 前缀</span></label><label className="file-field">微信支付公钥（PEM）<input type="file" accept=".pem,.pub" onChange={(event) => void readFile(event, "wechatpayPublicKey")} required={paymentVerifierRequired} /><span>{wechatpayPublicKey?.filename || config.wechatpay_public_key_filename || "在商户平台 API 安全页下载"}</span></label></div>}
    </section>
    <section className="form-section"><header><strong>微信公众号扫码登录</strong><small>客户端展示公众号带参二维码；未关注用户触发关注事件，已关注用户触发扫码事件</small></header>
      <div className="two-columns"><label>公众号名称<input value={form.official_account_name} onChange={(event) => setForm({ ...form, official_account_name: event.target.value })} required /></label><label>公众号 AppID<input value={form.app_id} onChange={(event) => setForm({ ...form, app_id: event.target.value })} placeholder="wx..." required /></label></div>
      <div className="two-columns"><label>公众号 AppSecret<input type="password" autoComplete="new-password" value={form.app_secret} onChange={(event) => setForm({ ...form, app_secret: event.target.value })} placeholder={config.app_secret_configured ? `已配置 ${config.app_secret_hint}，留空保留` : "请输入公众号 AppSecret"} required={!config.app_secret_configured} /></label><label>公众号服务器 Token<input type="password" autoComplete="new-password" value={form.official_account_token} onChange={(event) => setForm({ ...form, official_account_token: event.target.value })} placeholder={config.official_account_token_configured ? `已配置 ${config.official_account_token_hint}，留空保留` : "3～32 位字母或数字，并与公众平台一致"} required={!config.official_account_token_configured} /></label></div>
      <label>公众号事件回调地址<input type="url" value={form.official_account_callback_url} onChange={(event) => setForm({ ...form, official_account_callback_url: event.target.value })} required /></label>
      <div className="two-columns"><label>EncodingAESKey（可选）<input type="password" autoComplete="new-password" value={form.official_account_encoding_aes_key} onChange={(event) => setForm({ ...form, official_account_encoding_aes_key: event.target.value })} placeholder={config.official_account_encoding_aes_key_configured ? `已配置 ${config.official_account_encoding_aes_key_hint}，留空保留` : "安全模式填写 43 位；明文模式留空"} /></label><label>配置状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="DISABLED">停用</option><option value="ACTIVE">启用</option></select></label></div>
    </section>
    {error && <div className="form-error">{error}</div>}
    <footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "加密保存中…" : "保存微信配置"}</button></footer>
  </form></div>;
}
