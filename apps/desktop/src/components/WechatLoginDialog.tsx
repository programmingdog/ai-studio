import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { createWechatQrSession, pollWechatQrSession, type PlatformTokenResult, type WechatQrSession } from "../services/platform";
import { CustomAuthDialog } from "./CustomAuthDialog";

export function WechatIcon() {
  return <svg viewBox="0 0 32 32" width="36" height="36" fill="currentColor" aria-hidden="true">
    <path d="M12.5 4C6.7 4 2 7.7 2 12.3c0 2.6 1.5 5 4 6.5l-1 3.4 3.8-2a13 13 0 0 0 2.8.4 8 8 0 0 1-.6-3.1c0-5 4.5-8.5 10-8.5h.7C20.3 6.1 16.8 4 12.5 4Zm-3.6 5a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm7.1 0a1.3 1.3 0 1 1 0 2.6A1.3 1.3 0 0 1 16 9Z" />
    <path d="M21 10.5c-4.9 0-8.8 3.1-8.8 7s3.9 7 8.8 7c1 0 1.9-.1 2.8-.4l3.4 1.8-.9-3a6.7 6.7 0 0 0 3.5-5.4c0-3.9-3.9-7-8.8-7Zm-3 4.1a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Zm6 0a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
  </svg>;
}

export function WechatLoginDialog({ onClose, onAuthenticated }: { onClose: () => void; onAuthenticated: (result: PlatformTokenResult) => Promise<void> }) {
  const [session, setSession] = useState<WechatQrSession | null>(null);
  const [status, setStatus] = useState("正在生成微信登录二维码…");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [expired, setExpired] = useState(false);
  const onAuthenticatedRef = useRef(onAuthenticated);
  onAuthenticatedRef.current = onAuthenticated;
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    setSession(null); setError(""); setExpired(false); setStatus("正在生成微信登录二维码…");
    const start = async () => {
      try {
        const next = await createWechatQrSession();
        if (!active) return;
        setSession(next); setStatus("请使用微信扫码注册或登录");
        const poll = async () => {
          if (!active) return;
          if (new Date(next.expires_at).getTime() <= Date.now()) { setExpired(true); setStatus("二维码已过期，请刷新"); return; }
          try {
            // A cancelled dialog must not persist tokens returned by an in-flight poll.
            const result = await pollWechatQrSession(next.state, () => active);
            if (!active) return;
            if (typeof result.access_token === "string") {
              await onAuthenticatedRef.current(result as unknown as PlatformTokenResult);
              return;
            }
            if (result.status === "EXPIRED") { setExpired(true); setStatus("二维码已过期，请刷新"); return; }
            setError(""); setStatus(result.status === "SCANNED" ? "已扫码，请在微信中确认" : "请使用微信扫码注册或登录");
          } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "查询微信登录状态失败"); }
          if (active) timer = window.setTimeout(() => void poll(), 2500);
        };
        timer = window.setTimeout(() => void poll(), 1500);
      } catch (cause) { if (active) { setError(cause instanceof Error ? cause.message : "无法生成二维码"); setStatus(""); } }
    };
    void start();
    return () => { active = false; window.clearTimeout(timer); };
  }, [attempt]);
  return <CustomAuthDialog title="微信登录" onClose={onClose}>
    <div className="wechat-login-panel">
      {!session && !error && <LoaderCircle className="spin" size={32} />}
      {session && !expired && <div className="qr-card"><QRCodeSVG value={session.login_url} size={210} level="M" /></div>}
      <strong role="status">{status}</strong>
      <p>首次扫码会自动注册；已有微信账户将直接登录。</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {(session || error) && <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} />{error && !session ? "重新加载" : "刷新二维码"}</button>}
    </div>
  </CustomAuthDialog>;
}
