import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, LogIn } from "lucide-react";
import { EmailRegistrationVerification } from "./EmailRegistrationVerification";
import { WechatIcon, WechatLoginDialog } from "./WechatLoginDialog";
import { checkRegistrationEmail, deleteRememberedCredential, getClientAuthMethods, getRememberedCredentials, loginPlatform, registerPlatformEmail, saveRememberedCredential, platformApiBaseUrl, type ClientAuthMethods, type PlatformTokenResult, type RememberedCredential } from "../services/platform";

type EmailState = "idle" | "checking" | "registered" | "new" | "registration-disabled" | "error";
const emailPattern = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const defaultAuthMethods: ClientAuthMethods = { registration_enabled: true, email_enabled: true, phone_otp_enabled: false, phone_otp_available: false, wechat_enabled: true };

export function UnifiedAuthPanel({ onAuthenticated, forcePasswordEntry = false, initialEmail = "" }: { onAuthenticated: (result: PlatformTokenResult) => Promise<void>; forcePasswordEntry?: boolean; initialEmail?: string }) {
  const [authMethods, setAuthMethods] = useState<ClientAuthMethods | null>(null);
  const [authMethodsError, setAuthMethodsError] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailState, setEmailState] = useState<EmailState>("idle");
  const [checkError, setCheckError] = useState("");
  const [rememberedCredentials, setRememberedCredentials] = useState<RememberedCredential[]>([]);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [rememberError, setRememberError] = useState("");
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [wechatOpen, setWechatOpen] = useState(false);
  const checkId = useRef(0);
  const mounted = useRef(true);
  const checking = useRef(false);
  const submitting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; checkId.current++; }; }, []);
  useEffect(() => {
    let active = true;
    void getClientAuthMethods().then(result => {
      if (!active) return;
      setAuthMethods({ ...result, phone_otp_enabled: result.phone_otp_available && result.phone_otp_enabled });
      setAuthMethodsError("");
    }).catch(cause => {
      if (!active) return;
      setAuthMethods(defaultAuthMethods);
      setAuthMethodsError(cause instanceof Error ? cause.message : "登录方式配置读取失败");
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (forcePasswordEntry) { setRememberedCredentials([]); setPassword(""); return; }
    void getRememberedCredentials().then(credentials => {
      if (active) setRememberedCredentials(credentials);
    }).catch(cause => {
      if (active) setRememberError(cause instanceof Error ? cause.message : "已保存账号读取失败");
    });
    return () => { active = false; };
  }, [forcePasswordEntry]);
  useEffect(() => { if (authMethods && !authMethods.wechat_enabled) setWechatOpen(false); }, [authMethods?.wechat_enabled]);
  const normalized = email.trim().toLowerCase();
  const registering = emailState === "new";
  const inviteValid = !inviteCode || /^[A-Z0-9]{8}$/.test(inviteCode);
  const credentialsValid = emailPattern.test(normalized) && password.length >= 8 && password.length <= 128 && /[A-Za-z]/.test(password) && /\d/.test(password);
  const auth = useMutation({
    mutationFn: async () => {
      if (emailState === "registered") return loginPlatform({ identifier: normalized, password });
      if (emailState === "new") return registerPlatformEmail({ email: normalized, password, email_code: emailCode, display_name: displayName.trim() || undefined, invite_code: inviteCode || undefined });
      throw new Error("请先完成邮箱检查");
    },
    onSuccess: async result => {
      if (!forcePasswordEntry) {
        try {
          const credentials = rememberPassword
            ? await saveRememberedCredential(normalized, password)
            : await deleteRememberedCredential(normalized);
          if (mounted.current) setRememberedCredentials(credentials);
        } catch (cause) {
          console.error("更新已保存登录账号失败", cause);
        }
      }
      await onAuthenticated(result);
    },
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
      if (result.registered) setEmailState("registered");
      else if (forcePasswordEntry) { setEmailState("error"); setCheckError("请使用原账号并重新输入密码登录"); }
      else if (authMethods?.registration_enabled !== false) setEmailState("new");
      else { setEmailState("registration-disabled"); setCheckError("该邮箱尚未注册，当前暂未开放新用户注册"); }
    } catch (cause) {
      if (!mounted.current || id !== checkId.current) return;
      setEmailState("error"); setCheckError(cause instanceof Error ? cause.message : "邮箱检查失败，请重试");
    } finally { if (id === checkId.current) checking.current = false; }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || checking.current || submitting.current) return;
    if (emailState !== "registered" && emailState !== "new") { void checkEmail(); return; }
    if (!emailPattern.test(normalized) || password.length < 8 || (registering && (!credentialsValid || !inviteValid || !/^\d{6}$/.test(emailCode)))) return;
    submitting.current = true; auth.mutate();
  };
  const selectRememberedCredential = (account: string) => {
    const credential = rememberedCredentials.find(item => item.account === account);
    if (!credential) return;
    checkId.current++;
    checking.current = false;
    setEmail(credential.account);
    setPassword(credential.password);
    setEmailState("registered");
    setRememberPassword(true);
    setCheckError("");
    setRememberError("");
    setEmailCode("");
    setInviteCode("");
    auth.reset();
  };
  return <div className="auth-panel unified-auth-panel">
    {import.meta.env.DEV && <div className="auth-api-endpoint">调试 API：<code>{platformApiBaseUrl}</code></div>}
    {!authMethods && <div className="auth-methods-loading" role="status"><LoaderCircle className="spin" size={17} />正在读取登录方式…</div>}
    {authMethodsError && <div className="error-banner" role="alert">登录方式配置读取失败，已使用默认登录方式：{authMethodsError}</div>}
    {authMethods?.email_enabled && <form className="auth-form" onSubmit={submit}>
      {!forcePasswordEntry && rememberedCredentials.length > 0 && <label className="remembered-account-picker">选择已记住的账号<select value="" onChange={event => selectRememberedCredential(event.target.value)} disabled={busy}><option value="">请选择账号</option>{rememberedCredentials.map(credential => <option key={credential.account} value={credential.account}>{credential.account}</option>)}</select><small>选择后会自动填写对应密码。</small></label>}
      <label>邮箱<input type="email" value={email} onChange={event => {
        checkId.current++; checking.current = false;
        setEmail(event.target.value); setEmailState("idle"); setEmailCode(""); setInviteCode(""); setCheckError(""); setRememberPassword(false); setVerificationBusy(false); auth.reset();
      }} onBlur={() => void checkEmail()} disabled={busy} required maxLength={191} autoComplete="username" placeholder="name@example.com" /></label>
      {emailState === "checking" && <small className="auth-email-check" role="status"><LoaderCircle className="spin" size={14} />正在检查邮箱…</small>}
      {checkError && <div className="error-banner" role="alert">{checkError}<button type="button" className="auth-check-retry" disabled={busy} onClick={() => void checkEmail()}>重新检查</button></div>}
      <label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} required minLength={8} maxLength={128} autoComplete={forcePasswordEntry ? "off" : registering ? "new-password" : "current-password"} />{forcePasswordEntry && <small>登录状态已过期，本次必须重新输入密码，不能使用已保存密码自动填充。</small>}{registering && <small>8～128 位，必须同时包含字母和数字。</small>}</label>
      {!forcePasswordEntry && <label className="remember-login"><input type="checkbox" checked={rememberPassword} onChange={event => setRememberPassword(event.target.checked)} disabled={busy} /><span><strong>记住账号密码</strong><small>密码将加密保存在本机的系统凭据库中。</small></span></label>}
      {registering && <>
        <small className="auth-new-account" role="status">该邮箱尚未注册，完成以下信息即可注册并登录。</small>
        <label>昵称<input value={displayName} maxLength={100} disabled={busy} onChange={event => setDisplayName(event.target.value)} placeholder="选填" /></label>
        <label>邀请码<input value={inviteCode} maxLength={8} pattern="[A-Za-z0-9]{8}" autoComplete="off" disabled={busy} onChange={event => setInviteCode(event.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8))} placeholder="选填，8 位字母或数字" />{!inviteValid && <small className="auth-field-error">邀请码应为 8 位字母或数字，也可以留空。</small>}</label>
        <EmailRegistrationVerification key={normalized} email={normalized} credentialsValid={credentialsValid} code={emailCode} onCodeChange={setEmailCode} onBusyChange={setVerificationBusy} disabled={auth.isPending || wechatOpen} />
      </>}
      {auth.error && <div className="error-banner" role="alert">{auth.error.message}</div>}
      {rememberError && <div className="error-banner" role="alert">{rememberError}</div>}
      <button type="submit" className="primary-button auth-submit" disabled={busy || emailState === "checking" || emailState === "registration-disabled" || !emailPattern.test(normalized) || password.length < 8 || (registering && (!credentialsValid || !inviteValid || !/^\d{6}$/.test(emailCode)))}>{auth.isPending ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}{auth.isPending ? "正在登录…" : registering ? "注册并登录" : "登录"}</button>
    </form>}
    {!forcePasswordEntry && authMethods?.wechat_enabled && <div className="wechat-login-entry"><button type="button" aria-haspopup="dialog" disabled={busy || emailState === "checking"} onClick={() => setWechatOpen(true)}><span className="wechat-login-symbol"><i /><WechatIcon /><i /></span><span>微信登录</span></button></div>}
    {authMethods && (!authMethods.email_enabled && (forcePasswordEntry || !authMethods.wechat_enabled)) && <div className="error-banner" role="alert">当前没有可用的密码登录方式，请联系管理员。</div>}
    {!forcePasswordEntry && authMethods?.wechat_enabled && wechatOpen && <WechatLoginDialog registrationEnabled={authMethods.registration_enabled} onClose={() => setWechatOpen(false)} onAuthenticated={async result => { setWechatOpen(false); await onAuthenticated(result); }} />}
  </div>;
}
