import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Mail, RefreshCw, ShieldCheck, X } from "lucide-react";
import {
  createRegistrationCaptcha, verifyRegistrationCaptcha, sendRegistrationEmailCode,
  PlatformApiError, type RegistrationCaptcha,
} from "../services/platform";

export function EmailRegistrationVerification({ email, credentialsValid, code, onCodeChange, onBusyChange, disabled }: {
  email: string; credentialsValid: boolean; code: string; onCodeChange: (value: string) => void;
  onBusyChange: (busy: boolean) => void; disabled: boolean;
}) {
  const [captcha, setCaptcha] = useState<RegistrationCaptcha | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "verifying" | "sending">("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const requestId = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  const answerInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const busy = phase !== "idle";
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!dialogOpen) return;
    dialog.current?.focus();
    return () => {
      if (sendButton.current?.disabled) codeInput.current?.focus();
      else sendButton.current?.focus();
    };
  }, [dialogOpen]);
  useEffect(() => {
    if (!dialogOpen) return;
    if (captcha && !busy) answerInput.current?.focus();
    else dialog.current?.focus();
  }, [dialogOpen, captcha, busy]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) setRetryAt(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  const begin = (next: typeof phase) => {
    busyRef.current = true; setPhase(next); onBusyChange(true); setError("");
    return ++requestId.current;
  };
  const isCurrent = (id: number) => mounted.current && id === requestId.current;
  const finish = (id: number) => {
    if (!isCurrent(id)) return;
    busyRef.current = false;
    setPhase("idle"); onBusyChange(false);
  };
  const closeCaptcha = () => {
    if (phase === "sending") return;
    // Ignore late challenge/proof responses after cancellation, including after reopening.
    requestId.current++; busyRef.current = false;
    setDialogOpen(false); setCaptcha(null); setAnswer(""); setError(""); setPhase("idle"); onBusyChange(false);
  };
  const showError = (cause: unknown) => {
    if (!mounted.current) return;
    setError(cause instanceof Error ? cause.message : "请求失败，请重试");
    if (cause instanceof PlatformApiError && cause.status === 429) {
      const seconds = Number((cause.details as { retry_after_seconds?: number } | undefined)?.retry_after_seconds);
      if (Number.isFinite(seconds) && seconds > 0) { setNow(Date.now()); setRetryAt(Date.now() + seconds * 1000); }
    }
  };
  const refreshCaptcha = async () => {
    if (busyRef.current || disabled || !credentialsValid || cooldown > 0) return;
    const id = begin("loading"); setDialogOpen(true); setCaptcha(null); setAnswer("");
    try {
      const result = await createRegistrationCaptcha(email);
      if (isCurrent(id)) setCaptcha(result);
    } catch (cause) { if (isCurrent(id)) showError(cause); }
    finally { finish(id); }
  };
  const verifyAndSend = async () => {
    if (busyRef.current || disabled || !captcha || !answer.trim() || !credentialsValid || cooldown > 0) return;
    const id = begin("verifying");
    let verified = false;
    try {
      const proof = await verifyRegistrationCaptcha({ email, captcha_id: captcha.captcha_id, answer: answer.trim() });
      if (!isCurrent(id)) return;
      verified = true; setPhase("sending"); setCaptcha(null); setAnswer(""); setNotice(""); setUnconfirmed(false); onCodeChange("");
      // The mail request is only made after the API accepts the graphical challenge.
      const result = await sendRegistrationEmailCode({ email, captcha_token: proof.captcha_token });
      if (!isCurrent(id)) return;
      setNow(Date.now()); setRetryAt(Date.now() + result.retry_after_seconds * 1000);
      setNotice(`验证码已发送至 ${email}，${Math.ceil(result.expires_in / 60)} 分钟内有效，请同时检查垃圾邮件。`);
    } catch (cause) {
      if (!isCurrent(id)) return;
      const details = cause instanceof PlatformApiError ? cause.details as { code?: string; retry_after_seconds?: number; diagnostic_id?: string } | undefined : undefined;
      if (verified && mounted.current && details?.code === "MAIL_HTTP_DELIVERY_UNCONFIRMED") {
        const seconds = Number(details.retry_after_seconds);
        setNow(Date.now()); setRetryAt(Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000);
        setUnconfirmed(true); setNotice("邮件发送结果暂未确认。如已收到本次验证码，可直接填写并注册；未收到请稍候检查垃圾邮件，勿立即重复发送。");
      } else showError(cause);
      // A sending failure may already have consumed the proof; never reuse it.
      if (verified && mounted.current) setCaptcha(null);
    } finally {
      if (verified && isCurrent(id)) setDialogOpen(false);
      finish(id);
    }
  };

  return <div className="email-registration-verification">
    <label htmlFor="registration-email-code">邮箱验证码</label>
    <div className="email-code-row">
      <input ref={codeInput} id="registration-email-code" value={code} onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))} required pattern="[0-9]{6}" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 位邮箱验证码" disabled={disabled || busy} />
      <button ref={sendButton} type="button" className="secondary-button" aria-haspopup="dialog" onClick={() => void refreshCaptcha()} disabled={disabled || busy || dialogOpen || !credentialsValid || cooldown > 0}>
        {busy ? <LoaderCircle className="spin" size={16} /> : <Mail size={16} />}
        {phase === "sending" ? "正在发送…" : phase === "verifying" ? "正在验证…" : phase === "loading" ? "加载图形码…" : cooldown > 0 ? `${cooldown} 秒后重发` : "发送邮箱验证码"}
      </button>
    </div>
    <small>填写邮箱和密码后，先完成图形验证再发送邮件。</small>
    {dialogOpen && createPortal(<div className="modal-backdrop registration-captcha-backdrop" onMouseDown={(event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget) closeCaptcha();
    }}>
      <section className="registration-captcha" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="registration-captcha-title" aria-describedby="registration-captcha-description" aria-busy={busy} onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); closeCaptcha(); }
        if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
          const first = controls[0], last = controls[controls.length - 1];
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
        }
      }}>
        <header><h3 id="registration-captcha-title"><ShieldCheck size={20} />图形验证</h3><button type="button" className="modal-close" aria-label="关闭图形验证" disabled={phase === "sending"} onClick={closeCaptcha}><X size={18} /></button></header>
        <p id="registration-captcha-description">输入图片中的字符，验证通过后将发送邮箱验证码。</p>
        {phase === "loading" && <div className="registration-captcha-loading" role="status"><LoaderCircle className="spin" size={22} />正在加载图形验证码…</div>}
        {phase === "sending" && <div className="registration-captcha-loading" role="status"><LoaderCircle className="spin" size={22} />验证通过，正在发送邮件，请稍候…</div>}
        {captcha && <>
          <div className="registration-captcha-image"><img src={captcha.image_data_url} alt="图形验证码，请输入图片中的字符" width={200} height={64} /><button type="button" className="secondary-button" disabled={busy || disabled || cooldown > 0} onClick={() => void refreshCaptcha()}><RefreshCw size={14} />换一张</button></div>
          <label htmlFor="registration-captcha-answer">图形验证码（不区分大小写）</label>
          <input ref={answerInput} id="registration-captcha-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={10} autoComplete="off" spellCheck={false} placeholder="输入图片中的 5 位字符" disabled={busy || disabled} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void verifyAndSend(); } }} />
        </>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {!captcha && !busy && <button type="button" className="secondary-button" disabled={disabled || cooldown > 0} onClick={() => void refreshCaptcha()}><RefreshCw size={14} />{cooldown > 0 ? `${cooldown} 秒后重试` : "重新加载验证码"}</button>}
        <footer><button type="button" className="secondary-button" disabled={phase === "sending"} onClick={closeCaptcha}>取消</button><button type="button" className="primary-button" disabled={busy || disabled || !captcha || !answer.trim() || cooldown > 0} onClick={() => void verifyAndSend()}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{phase === "verifying" ? "正在验证…" : phase === "sending" ? "正在发送…" : "验证并发送"}</button></footer>
      </section>
    </div>, document.body)}
    {notice && <div className={`${unconfirmed ? "" : "settings-success "}email-verification-notice`} role="status">{notice}</div>}
    {error && !dialogOpen && <div className="error-banner" role="alert">{error}</div>}
  </div>;
}
