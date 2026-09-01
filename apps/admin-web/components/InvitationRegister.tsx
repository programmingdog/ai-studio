"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { apiRequest, ApiError } from "@/lib/api";

type Invitation = { invite_code: string; windows_download_url: string; macos_download_url: string };
type Captcha = { captcha_id: string; image_data_url: string };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function InvitationRegister({ code }: { code: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [name, setName] = useState(""), [emailCode, setEmailCode] = useState("");
  const [complete, setComplete] = useState(false), [busy, setBusy] = useState(false), [phase, setPhase] = useState(""), [retryAt, setRetryAt] = useState(0), [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false), [captcha, setCaptcha] = useState<Captcha | null>(null), [answer, setAnswer] = useState("");
  const dialog = useRef<HTMLElement>(null), answerInput = useRef<HTMLInputElement>(null), sendButton = useRef<HTMLButtonElement>(null), codeInput = useRef<HTMLInputElement>(null);
  const version = useRef(0), lock = useRef(false), mounted = useRef(true);
  const normalized = email.trim().toLowerCase();
  const valid = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(normalized) && password.length >= 8 && password.length <= 128 && /[A-Za-z]/.test(password) && /\d/.test(password);
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    mounted.current = true; let active = true;
    apiRequest<Invitation>(`/referrals/invitations/${encodeURIComponent(code)}`).then(value => { if (active) setInvitation(value); }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; mounted.current = false; version.current++; };
  }, [code]);
  useEffect(() => { if (!retryAt) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [retryAt]);
  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    dialog.current?.focus();
    return () => { document.body.style.overflow = overflow; if (sendButton.current?.disabled) codeInput.current?.focus(); else sendButton.current?.focus(); };
  }, [open]);
  useEffect(() => { if (open) { if (captcha && !busy) answerInput.current?.focus(); else dialog.current?.focus(); } }, [open, captcha, busy]);
  const current = (id: number) => mounted.current && id === version.current;
  const failure = (cause: unknown) => {
    setError(errorText(cause));
    if (cause instanceof ApiError && cause.status === 429) { const seconds = Number(cause.details.retry_after_seconds); if (Number.isFinite(seconds) && seconds > 0) { setNow(Date.now()); setRetryAt(Date.now() + seconds * 1000); } }
  };
  const close = () => {
    if (phase === "sending") return;
    version.current++; lock.current = false; setOpen(false); setCaptcha(null); setAnswer(""); setBusy(false); setPhase(""); setError("");
  };
  const loadCaptcha = async () => {
    if (lock.current || !valid || cooldown > 0 || !invitation) return;
    const id = ++version.current;
    lock.current = true; setBusy(true); setPhase("loading"); setOpen(true); setError(""); setCaptcha(null); setAnswer("");
    try { const result = await apiRequest<Captcha>("/auth/register/email/captcha", { method: "POST", body: JSON.stringify({ email: normalized }) }); if (current(id)) setCaptcha(result); }
    catch (cause) { if (current(id)) failure(cause); }
    finally { if (current(id)) { lock.current = false; setBusy(false); setPhase(""); } }
  };
  const send = async () => {
    if (lock.current || !captcha || !answer.trim() || !valid || cooldown > 0) return;
    const id = ++version.current;
    lock.current = true; setBusy(true); setPhase("verifying"); setError("");
    let verified = false;
    try {
      const proof = await apiRequest<{ captcha_token: string }>("/auth/register/email/captcha/verify", { method: "POST", body: JSON.stringify({ email: normalized, captcha_id: captcha.captcha_id, answer }) });
      if (!current(id)) return;
      verified = true; setPhase("sending"); setCaptcha(null); setEmailCode(""); setNotice("");
      const result = await apiRequest<{ retry_after_seconds: number }>("/auth/register/email/code", { method: "POST", body: JSON.stringify({ email: normalized, captcha_token: proof.captcha_token }) });
      if (!current(id)) return;
      setNow(Date.now()); setRetryAt(Date.now() + result.retry_after_seconds * 1000); setNotice("验证码已发送，10 分钟内有效，请检查收件箱或垃圾邮件。");
    } catch (cause) {
      if (!current(id)) return;
      if (verified && cause instanceof ApiError && cause.details.code === "MAIL_HTTP_DELIVERY_UNCONFIRMED") {
        setNotice("邮件发送结果暂未确认。如已收到本次验证码，可直接填写注册；请勿立即重复发送。"); setNow(Date.now()); setRetryAt(Date.now() + 60000);
      } else failure(cause);
    } finally { if (current(id)) { lock.current = false; setBusy(false); setPhase(""); if (verified) setOpen(false); } }
  };
  const register = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current || !valid || !/^\d{6}$/.test(emailCode) || !invitation) return;
    lock.current = true; setBusy(true); setError("");
    try {
      // The inviter comes from this immutable route, never from a caller-provided pid.
      const result = await apiRequest<{ access_token: string }>("/auth/register/email", { method: "POST", body: JSON.stringify({ email: normalized, password, display_name: name || undefined, email_code: emailCode, invite_code: invitation.invite_code }) });
      // This page is a registration/download landing page, not a persistent web session.
      void apiRequest("/auth/logout", { method: "POST" }, result.access_token).catch(() => {});
      if (!mounted.current) return;
      setComplete(true); setPassword(""); setEmailCode(""); setNotice("");
    } catch (cause) { if (mounted.current) failure(cause); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  return <main className="invite-page"><section className="invite-intro"><div className="brand"><span className="brand-mark">AI</span><div><strong>AI Video Studio</strong><small>CREATE WITH A FRIEND</small></div></div><h1>从一次邀请，<br />开始你的创作。</h1><p>注册、绑定邀请关系，然后下载客户端。项目和生成素材保存在你的电脑。</p><ol><li>验证邮箱并创建账户</li><li>自动绑定邀请人</li><li>下载安装，用同一邮箱登录</li></ol></section>
    <section className="invite-registration"><span className="kicker">好友邀请码 · {code}</span><h2>{complete ? "注册成功，欢迎加入" : "注册并下载"}</h2>
      {error && !open && <div className="form-error" role="alert">{error}</div>}
      {!invitation ? <p>{error ? "邀请链接暂不可用，请联系邀请人核对。" : "正在核对邀请链接…"}</p> : complete ? <><p>已为 {normalized} 创建账户并绑定邀请人。安装后请使用此邮箱和刚才设置的密码登录，无需再次注册。</p><div className="invite-downloads">{invitation.windows_download_url && <a className="primary" href={invitation.windows_download_url} rel="noreferrer">下载 Windows 客户端</a>}{invitation.macos_download_url && <a className="secondary" href={invitation.macos_download_url} rel="noreferrer">下载 macOS 客户端</a>}{!invitation.windows_download_url && !invitation.macos_download_url && <p>管理员尚未配置安装包下载地址，请联系邀请人获取安装包。账户与邀请关系已保存。</p>}</div></> : <form onSubmit={register}>
        <fieldset disabled={busy || open}><label>邮箱<input type="email" value={email} onChange={e => { setEmail(e.target.value); setEmailCode(""); setNotice(""); setError(""); }} autoComplete="username" maxLength={191} required /></label><label>密码<input type="password" value={password} minLength={8} maxLength={128} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required /><small>8～128 位，同时包含字母和数字。</small></label><label>昵称<input value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="选填" /></label><label>邮箱验证码<div className="invite-code-row"><input ref={codeInput} value={emailCode} onChange={e => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /><button ref={sendButton} className="secondary" type="button" disabled={!valid || busy || cooldown > 0} aria-haspopup="dialog" onClick={() => void loadCaptcha()}>{cooldown ? `${cooldown} 秒后重发` : "发送邮箱验证码"}</button></div></label></fieldset>
        {notice && <p role="status">{notice}</p>}<p className="invite-disclosure">注册成功即绑定邀请码 {code} 对应的邀请人；已有账户不重新绑定。邀请人会获得平台配置的积分奖励。</p><button className="primary" disabled={busy || open || !valid || !/^\d{6}$/.test(emailCode)}>{busy ? "处理中…" : "创建账户并绑定邀请"}</button>
      </form>}
    </section>
    {open && createPortal(<div className="distribution-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><section className="distribution-modal invite-captcha" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="图形验证" onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "Tab") { const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')); const first = controls[0], last = controls.at(-1); if (!first) e.preventDefault(); else if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === e.currentTarget)) { e.preventDefault(); first.focus(); } }
    }}><header><h2>图形验证</h2><button type="button" className="secondary" disabled={phase === "sending"} onClick={close}>关闭</button></header><p>完成图形验证后发送邮件。</p>{phase === "loading" && <p role="status">正在加载验证码…</p>}{phase === "sending" && <p role="status">验证通过，正在发送邮件…</p>}{captcha && <><div className="invite-captcha-image"><img src={captcha.image_data_url} width={200} height={64} alt="图形验证码" /><button type="button" className="secondary" disabled={busy || cooldown > 0} onClick={() => void loadCaptcha()}>换一张</button></div><label>图形验证码<input ref={answerInput} value={answer} onChange={e => setAnswer(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void send(); } }} disabled={busy} maxLength={10} autoComplete="off" placeholder="输入图片中的字符" /></label></>}{error && <div className="form-error" role="alert">{error}</div>}{!captcha && !busy && <button className="secondary" disabled={cooldown > 0} onClick={() => void loadCaptcha()}>{cooldown ? `${cooldown} 秒后重试` : "重新加载"}</button>}<button type="button" className="primary" disabled={busy || !captcha || !answer.trim() || cooldown > 0} onClick={() => void send()}>{phase === "verifying" ? "正在验证…" : "验证并发送"}</button></section></div>, document.body)}
  </main>;
}
