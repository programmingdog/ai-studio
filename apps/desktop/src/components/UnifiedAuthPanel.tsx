import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, LogIn } from "lucide-react";
import { EmailRegistrationVerification } from "./EmailRegistrationVerification";
import { WechatIcon, WechatLoginDialog } from "./WechatLoginDialog";
import { checkRegistrationEmail, loginPlatform, registerPlatformEmail, platformApiBaseUrl, type PlatformTokenResult } from "../services/platform";

type EmailState = "idle" | "checking" | "registered" | "new" | "error";
const emailPattern = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function UnifiedAuthPanel({ onAuthenticated }: { onAuthenticated: (result: PlatformTokenResult) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailState, setEmailState] = useState<EmailState>("idle");
  const [checkError, setCheckError] = useState("");
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [wechatOpen, setWechatOpen] = useState(false);
  const checkId = useRef(0);
  const mounted = useRef(true);
  const checking = useRef(false);
  const submitting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; checkId.current++; }; }, []);
  const normalized = email.trim().toLowerCase();
  const registering = emailState === "new";
  const credentialsValid = emailPattern.test(normalized) && password.length >= 8 && password.length <= 128 && /[A-Za-z]/.test(password) && /\d/.test(password);
  const auth = useMutation({
    mutationFn: async () => {
      if (emailState === "registered") return loginPlatform({ identifier: normalized, password });
      if (emailState === "new") return registerPlatformEmail({ email: normalized, password, email_code: emailCode, display_name: displayName.trim() || undefined });
      throw new Error("请先完成邮箱检查");
    },
    onSuccess: onAuthenticated,
    onSettled: () => { submitting.current = false; },
  });
  const busy = auth.isPending || verificationBusy || wechatOpen;
  const checkEmail = async () => {
    if (busy || checking.current || emailState === "registered" || emailState === "new") return;
    if (!emailPattern.test(normalized)) {
      setEmailState(email ? "error" : "idle"); setCheckError(email ? "请输入有效的邮箱地址" : ""); return;
    }
    const id = ++checkId.current;
    checking.current = true; setEmailState("checking"); setCheckError("");
    try {
      const result = await checkRegistrationEmail(normalized);
      if (!mounted.current || id !== checkId.current) return;
      setEmailState(result.registered ? "registered" : "new");
    } catch (cause) {
      if (!mounted.current || id !== checkId.current) return;
      setEmailState("error"); setCheckError(cause instanceof Error ? cause.message : "邮箱检查失败，请重试");
    } finally { if (id === checkId.current) checking.current = false; }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || checking.current || submitting.current) return;
    if (emailState !== "registered" && emailState !== "new") { void checkEmail(); return; }
    if (!emailPattern.test(normalized) || password.length < 8 || (registering && (!credentialsValid || !/^\d{6}$/.test(emailCode)))) return;
    submitting.current = true; auth.mutate();
  };
  return <div className="auth-panel unified-auth-panel">
    {import.meta.env.DEV && <div className="auth-api-endpoint">调试 API：<code>{platformApiBaseUrl}</code></div>}
    <form className="auth-form" onSubmit={submit}>
      <label>邮箱<input type="email" value={email} onChange={event => {
        checkId.current++; checking.current = false;
        setEmail(event.target.value); setEmailState("idle"); setEmailCode(""); setCheckError(""); setVerificationBusy(false); auth.reset();
      }} onBlur={() => void checkEmail()} disabled={busy} required maxLength={191} autoComplete="username" placeholder="name@example.com" /></label>
      {emailState === "checking" && <small className="auth-email-check" role="status"><LoaderCircle className="spin" size={14} />正在检查邮箱…</small>}
      {checkError && <div className="error-banner" role="alert">{checkError}<button type="button" className="auth-check-retry" disabled={busy} onClick={() => void checkEmail()}>重新检查</button></div>}
      <label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} required minLength={8} maxLength={128} autoComplete={registering ? "new-password" : "current-password"} />{registering && <small>8～128 位，必须同时包含字母和数字。</small>}</label>
      {registering && <>
        <small className="auth-new-account" role="status">该邮箱尚未注册，完成以下信息即可注册并登录。</small>
        <label>昵称<input value={displayName} maxLength={100} disabled={busy} onChange={event => setDisplayName(event.target.value)} placeholder="选填" /></label>
        <EmailRegistrationVerification key={normalized} email={normalized} credentialsValid={credentialsValid} code={emailCode} onCodeChange={setEmailCode} onBusyChange={setVerificationBusy} disabled={auth.isPending || wechatOpen} />
      </>}
      {auth.error && <div className="error-banner" role="alert">{auth.error.message}</div>}
      <button type="submit" className="primary-button auth-submit" disabled={busy || emailState === "checking" || !emailPattern.test(normalized) || password.length < 8 || (registering && (!credentialsValid || !/^\d{6}$/.test(emailCode)))}>{auth.isPending ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}{auth.isPending ? "正在登录…" : registering ? "注册并登录" : "登录"}</button>
    </form>
    <div className="wechat-login-entry"><button type="button" aria-haspopup="dialog" disabled={busy || emailState === "checking"} onClick={() => setWechatOpen(true)}><span className="wechat-login-symbol"><i /><WechatIcon /><i /></span><span>微信登录</span></button></div>
    {wechatOpen && <WechatLoginDialog onClose={() => setWechatOpen(false)} onAuthenticated={async result => { setWechatOpen(false); await onAuthenticated(result); }} />}
  </div>;
}
