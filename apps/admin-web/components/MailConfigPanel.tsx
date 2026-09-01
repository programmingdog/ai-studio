"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";

type MailConfig = {
  api_url: string; mail_from: string; password_configured: boolean;
  delivery_method: "HTTP" | "SMTP"; smtp_host: string; smtp_port: number; smtp_security: "STARTTLS" | "TLS";
  status: "ACTIVE" | "DISABLED"; revision: number; updated_at: string;
};
const emptyForm = { api_url: "", delivery_method: "HTTP" as MailConfig["delivery_method"], smtp_host: "mail.yuntianxing.net", smtp_port: "25", smtp_security: "STARTTLS" as MailConfig["smtp_security"], mail_from: "", password: "", status: "DISABLED" as MailConfig["status"] };

export function MailConfigPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<MailConfig | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestId = useRef(0);
  const savingRef = useRef(false);
  const loadingRef = useRef(true);
  const apply = (result: MailConfig) => {
    setConfig(result);
    setForm({ api_url: result.api_url, delivery_method: result.delivery_method, smtp_host: result.smtp_host, smtp_port: String(result.smtp_port), smtp_security: result.smtp_security, mail_from: result.mail_from, password: "", status: result.status });
  };
  const load = useCallback(async (signal?: AbortSignal) => {
    if (savingRef.current) return;
    const id = ++requestId.current;
    loadingRef.current = true; setLoading(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<MailConfig>("/admin/configs/mail", { signal }, token);
      if (!signal?.aborted && requestId.current === id) apply(result);
    } catch (reason) {
      if (!signal?.aborted && requestId.current === id) { setConfig(null); setForm(emptyForm); setError(reason instanceof Error ? reason.message : "读取邮箱配置失败"); }
    } finally {
      if (requestId.current === id) { loadingRef.current = false; setLoading(false); }
    }
  }, [token]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config || loadingRef.current || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<MailConfig>("/admin/configs/mail", { method: "PATCH", body: JSON.stringify({ ...form, smtp_port: Number(form.smtp_port), password: form.password || undefined, revision: config.revision }) }, token);
      apply(result);
      setMessage(result.status === "ACTIVE" ? "邮箱配置已保存，后续注册验证码邮件将使用新配置，无需重启服务。" : "邮箱配置已保存，邮件验证码发送已停用。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存邮箱配置失败"); }
    finally { savingRef.current = false; setSaving(false); }
  }
  const targetChanged = Boolean(config?.password_configured && (form.delivery_method !== config.delivery_method || form.mail_from.trim().toLowerCase() !== config.mail_from || (form.delivery_method === "HTTP"
    ? form.api_url.trim() !== config.api_url
    : form.smtp_host.trim().toLowerCase() !== config.smtp_host || Number(form.smtp_port) !== config.smtp_port || form.smtp_security !== config.smtp_security)));
  const passwordRequired = targetChanged || (form.status === "ACTIVE" && !config?.password_configured);
  const busy = loading || saving;

  return <section className="section-card mail-config-card">
    <header><div><span className="kicker">REGISTRATION EMAIL</span><h2>邮箱配置</h2><p>配置注册验证码邮件服务。发件密码加密保存，不会回显或发送到桌面客户端。</p></div>{config && <span className={`status ${config.status === "ACTIVE" ? "good" : "bad"}`}>{config.status === "ACTIVE" ? "已启用" : "已停用"}</span>}</header>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    {loading && <div className="loading-card"><span className="spinner" />正在读取邮箱配置…</div>}
    <form className="mail-config-form" onSubmit={save}>
      <fieldset disabled={!config || busy}>
        <label>发件方式<select name="delivery_method" value={form.delivery_method} onChange={(event) => setForm({ ...form, delivery_method: event.target.value as MailConfig["delivery_method"] })}><option value="HTTP">HTTP API（宝塔邮件接口）</option><option value="SMTP">SMTP（直连邮局服务）</option></select></label>
        {form.delivery_method === "HTTP" ? <label>邮件 API 地址（MAIL_API_URL）<input type="url" value={form.api_url} onChange={(event) => setForm({ ...form, api_url: event.target.value })} required maxLength={500} placeholder="http://211.154.25.178:15686/mail_sys/send_mail_http.json" /><small>支持完整 HTTP 或 HTTPS 发件接口地址，须包含实际面板端口；SMTP 主机与端口不能作为 HTTP API 地址。</small>{/^http:\/\//i.test(form.api_url.trim()) && <small role="note">安全提示：HTTP 会明文传输发件邮箱密码、收件地址和验证码邮件内容；数据库加密不能保护传输过程，请确认网络可信。</small>}</label> : <>
          <div className="two-columns">
            <label>SMTP 主机<input name="smtp_host" type="text" value={form.smtp_host} onChange={(event) => setForm({ ...form, smtp_host: event.target.value })} required maxLength={253} autoComplete="off" placeholder="mail.yuntianxing.net" /><small>仅填写域名，不含 smtp://、端口或路径。</small></label>
            <label>SMTP 端口<input name="smtp_port" type="number" value={form.smtp_port} onChange={(event) => setForm({ ...form, smtp_port: event.target.value })} required min={1} max={65535} step={1} /></label>
          </div>
          <label>SMTP 加密方式<select name="smtp_security" value={form.smtp_security} onChange={(event) => setForm({ ...form, smtp_security: event.target.value as MailConfig["smtp_security"] })}><option value="STARTTLS">STARTTLS（通常 25 / 587）</option><option value="TLS">SSL/TLS（通常 465）</option></select><small>STARTTLS 必须由邮局支持；证书须可信且匹配主机域名。不会降级为明文发送密码。25 端口还需确保 API 服务器的出站连接未被限制。</small></label>
        </>}
        <div className="two-columns">
          <label>发件邮箱（MAIL_API_FROM）<input type="email" value={form.mail_from} onChange={(event) => setForm({ ...form, mail_from: event.target.value })} required={form.status === "ACTIVE"} maxLength={191} autoComplete="off" placeholder="例如 no-reply@yuntianxing.net" /></label>
          <label>发件邮箱密码（MAIL_API_PASSWORD）<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required={passwordRequired} maxLength={500} autoComplete="new-password" placeholder={targetChanged ? "发件配置已改变，请重新填写密码" : config?.password_configured ? "已配置，留空保留原密码" : "请输入发件邮箱密码"} /><small>{targetChanged ? "已修改发件方式、服务器或邮箱，请重新填写密码。" : config?.password_configured ? "密码已加密保存；输入新密码可替换，留空不修改。" : "使用邮件服务中的发件邮箱密码，不是后台登录密码。"}</small></label>
        </div>
        <label className="mail-config-status">服务状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as MailConfig["status"] })}><option value="DISABLED">停用</option><option value="ACTIVE">启用</option></select></label>
      </fieldset>
      <p className="supplier-pricing-note">保存后立即生效。SMTP 使用完整发件邮箱作为认证账号，POP/IMAP 收信配置无需填写。启用前需填写发件邮箱和密码；修改发件方式、服务器、端口、加密方式或发件邮箱时需重新填写密码。停用仅暂停验证码发件，不影响已有账户登录。</p>
      {config && <small className="mail-config-updated">最近更新：{new Date(config.updated_at).toLocaleString("zh-CN", { hour12: false })}</small>}
      <div className="mail-config-actions"><button className="primary" disabled={!config || busy}>{saving ? "加密保存中…" : "保存邮箱配置"}</button><button type="button" className="secondary" disabled={busy} onClick={() => void load()}>重新读取（放弃未保存修改）</button></div>
    </form>
  </section>;
}
