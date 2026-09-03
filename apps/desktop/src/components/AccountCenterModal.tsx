import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2, CircleUserRound, Clock3, Coins, CreditCard, LoaderCircle, LogOut, Save, X } from "lucide-react";
import { UnifiedAuthPanel } from "./UnifiedAuthPanel";
import { InvitationCard, ReferralPanel } from "./ReferralPanel";
import {
  clearInvalidPlatformSession, createCreditPurchase, getCreditBalance, getCreditPurchase,
  getPlatformUser, listCreditConsumptions, listCreditPackages, listCreditPurchases,
  loadPlatformSession, logoutPlatform, updatePlatformUser,
  PlatformApiError, type PlatformPurchase, type PlatformUser,
} from "../services/platform";
import { useI18n } from "../i18n";
import { localizedStatusLabel } from "../i18n/statusLabels";
import { useProductBrand } from "../brand";

function message(error: unknown): string { return error instanceof Error ? error.message : String(error || "请求失败"); }
function date(value?: string | null): string { return value ? new Date(value).toLocaleString("zh-CN") : "—"; }
function money(fen?: number): string { return `¥${((fen || 0) / 100).toFixed(2)}`; }
function taskTone(status: string): string { return ["SUCCEEDED", "COMPLETED", "CONFIRMED", "RELEASED", "PAID"].includes(status) ? "success" : ["FAILED", "CANCELED", "CANCELLED", "EXPIRED"].includes(status) ? "error" : "pending"; }
const terminalPurchaseStatuses = ["PAID", "CANCELED", "EXPIRED", "FAILED"];
function countdownText(seconds: number | null): string {
  if (seconds === null) return "--:--";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].slice(hours ? 0 : 1).map(value => String(value).padStart(2, "0")).join(":");
}

export function AccountCenterModal({ onClose, required = false, initialSection = "account" }: { onClose: () => void; required?: boolean; initialSection?: "account" | "credits" }) {
  const { productName } = useProductBrand();
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["platform-session"], queryFn: loadPlatformSession, staleTime: Infinity });
  const loggedIn = Boolean(session.data);
  const user = useQuery({ queryKey: ["platform-user"], queryFn: getPlatformUser, enabled: loggedIn, retry: false });
  const [section, setSection] = useState<"account" | "credits" | "referrals">(initialSection);
  useEffect(() => {
    if (!(user.error instanceof PlatformApiError) || user.error.status !== 401) return;
    void clearInvalidPlatformSession().finally(() => queryClient.setQueryData(["platform-session"], null));
  }, [queryClient, user.error]);

  const acceptLogin = async (result: { user: PlatformUser }) => {
    queryClient.setQueryData(["platform-session"], await loadPlatformSession());
    queryClient.setQueryData(["platform-user"], result.user);
  };

  const logout = useMutation({ mutationFn: logoutPlatform, onSuccess: () => { queryClient.setQueryData(["platform-session"], null); queryClient.removeQueries({ queryKey: ["platform-user"] }); setSection("account"); } });

  return <div className={`modal-backdrop account-modal-backdrop${required ? " account-login-backdrop" : ""}`} onMouseDown={(event) => { if (!required && event.target === event.currentTarget) onClose(); }}>
    <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-center-title">
      <header><div><span className="eyebrow">PLATFORM ACCOUNT</span><h2 id="account-center-title">{loggedIn ? "账户与积分中心" : `登录 ${productName}`}</h2><p>{loggedIn ? "管理账户资料、积分和微信支付订单。" : "必须先登录；项目、资产和处理记录会按账户隔离保存。"}</p></div>{!required && <button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>}</header>
      {session.isLoading ? <div className="account-loading"><LoaderCircle className="spin" />正在读取安全登录会话…</div> : !loggedIn ? <UnifiedAuthPanel onAuthenticated={acceptLogin} /> : <>
        <nav className="account-tabs"><button className={section === "account" ? "active" : ""} onClick={() => setSection("account")}><CircleUserRound size={16} />账户资料</button><button className={section === "credits" ? "active" : ""} onClick={() => setSection("credits")}><Coins size={16} />积分与购买</button><button className={section === "referrals" ? "active" : ""} onClick={() => setSection("referrals")}><CreditCard size={16} />分润与提现</button></nav>
        <div className="account-body">
          {section === "account" ? <ProfilePanel user={user.data} loading={user.isLoading} error={user.error} onSaved={(next) => queryClient.setQueryData(["platform-user"], next)} onLogout={() => logout.mutate()} loggingOut={logout.isPending} /> : section === "credits" ? <CreditsPanel /> : <ReferralPanel key={user.data?.id} userId={user.data?.id} />}
        </div>
      </>}
    </section>
  </div>;
}

function ProfilePanel({ user, loading, error, onSaved, onLogout, loggingOut }: { user?: PlatformUser; loading: boolean; error: unknown; onSaved: (user: PlatformUser) => void; onLogout: () => void; loggingOut: boolean }) {
  const [form, setForm] = useState({ display_name: "", email: "", phone: "", avatar_url: "", bio: "", current_password: "", new_password: "" });
  useEffect(() => { if (user) setForm({ display_name: user.display_name || "", email: user.email || "", phone: user.phone || "", avatar_url: user.avatar_url || "", bio: user.bio || "", current_password: "", new_password: "" }); }, [user]);
  const save = useMutation({ mutationFn: () => updatePlatformUser({ ...form, email: form.email || null, phone: form.phone || null, avatar_url: form.avatar_url || null, current_password: form.current_password || undefined, new_password: form.new_password || undefined }), onSuccess: (next) => { onSaved(next); setForm((current) => ({ ...current, current_password: "", new_password: "" })); } });
  if (loading) return <div className="account-loading"><LoaderCircle className="spin" />正在读取账户…</div>;
  if (error || !user) return <div className="error-banner">{message(error || "无法读取账户")}</div>;
  return <div className="profile-panel"><section className="account-summary"><div className="account-avatar">{user.display_name?.slice(0, 1).toUpperCase() || "U"}</div><div><strong>{user.display_name}</strong><span>{user.email || user.phone || "微信用户"}</span><small>注册于 {date(user.created_at)}</small></div><button className="secondary-button" onClick={onLogout} disabled={loggingOut}><LogOut size={15} />退出登录</button></section>
    <InvitationCard userId={user.id} />
    <label>上级用户 ID（pid）<input readOnly value={user.pid || "无上级"} /></label>
    <label>分润余额（含提现冻结）<input readOnly value={`¥${(Number(user.balance_fen || 0) / 100).toFixed(2)}`} /><small>分润到账时增加，实际打款后扣减；可提现金额和记录见“分润与提现”。</small></label>
    <div className="profile-grid"><label>显示名称<input value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} /></label><label>邮箱<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label><label>手机号<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label><label>HTTPS 头像地址<input value={form.avatar_url} onChange={(event) => setForm({ ...form, avatar_url: event.target.value })} /></label></div>
    <label>个人简介<textarea rows={3} value={form.bio} onChange={(event) => setForm({ ...form, bio: event.target.value })} /></label><div className="profile-grid"><label>当前密码<input type="password" value={form.current_password} onChange={(event) => setForm({ ...form, current_password: event.target.value })} placeholder="修改凭据时填写" /></label><label>新密码<input type="password" value={form.new_password} onChange={(event) => setForm({ ...form, new_password: event.target.value })} placeholder="不修改请留空" /></label></div>
    {save.error && <div className="error-banner">{message(save.error)}</div>}{save.isSuccess && <div className="settings-success"><CheckCircle2 size={16} />资料已更新</div>}<button className="primary-button profile-save" onClick={() => save.mutate()} disabled={save.isPending || !form.display_name.trim()}>{save.isPending ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存资料</button>
  </div>;
}

function CreditsPanel() {
  const queryClient = useQueryClient();
  const balance = useQuery({ queryKey: ["credit-balance"], queryFn: getCreditBalance });
  const packages = useQuery({ queryKey: ["credit-packages"], queryFn: listCreditPackages });
  const purchases = useQuery({ queryKey: ["credit-purchases"], queryFn: listCreditPurchases });
  const consumptions = useQuery({ queryKey: ["credit-consumptions"], queryFn: listCreditConsumptions });
  const [activePurchase, setActivePurchase] = useState<PlatformPurchase | null>(null);
  const purchase = useMutation({ mutationFn: createCreditPurchase, onSuccess: (result, packageId) => {
    const selectedPackage = packages.data?.find(item => item.id === packageId);
    setActivePurchase({ ...result, package_name_snapshot: result.package_name_snapshot || selectedPackage?.name, credits_granted: result.credits_granted ?? result.credits ?? selectedPackage?.total_credits });
    void queryClient.invalidateQueries({ queryKey: ["credit-purchases"] });
  } });
  useEffect(() => {
    if (!activePurchase || terminalPurchaseStatuses.includes(activePurchase.status)) return;
    if (activePurchase.expires_at && new Date(activePurchase.expires_at).getTime() <= Date.now()) {
      setActivePurchase(current => current ? { ...current, status: "EXPIRED" } : current);
      return;
    }
    const timer = window.setInterval(async () => {
      if (activePurchase.expires_at && new Date(activePurchase.expires_at).getTime() <= Date.now()) {
        setActivePurchase(current => current ? { ...current, status: "EXPIRED" } : current);
        return;
      }
      try { const next = await getCreditPurchase(activePurchase.id); setActivePurchase(next); if (next.status === "PAID") { void queryClient.invalidateQueries({ queryKey: ["credit-balance"] }); void queryClient.invalidateQueries({ queryKey: ["credit-purchases"] }); } } catch { /* 下一轮继续 */ }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activePurchase, queryClient]);
  return <div className="credits-panel"><div className="balance-grid"><article><span>积分余额</span><strong>{balance.data?.balance ?? "—"}</strong></article><article><span>正在使用的积分</span><strong>{balance.data?.held ?? "—"}</strong></article><article className="available"><span>可用积分</span><strong>{balance.data?.available ?? "—"}</strong></article></div>
    <section className="platform-section"><header><div><strong>积分套餐</strong><span>使用微信扫码支付，支付成功后积分自动到账。</span></div></header><div className="package-grid">{packages.data?.map((item) => <article key={item.id}><span>{item.name}</span><strong>{item.total_credits}<small> 积分</small></strong><p>{item.description}</p>{item.bonus_credits > 0 && <em>含赠送 {item.bonus_credits}</em>}<button className="primary-button" onClick={() => purchase.mutate(item.id)} disabled={purchase.isPending}><CreditCard size={15} />{money(item.price_fen)} 购买</button></article>)}</div>{purchase.error && <div className="error-banner">{message(purchase.error)}</div>}</section>
    {activePurchase && createPortal(<PaymentDialog purchase={activePurchase} onClose={() => setActivePurchase(null)} />, document.body)}
    <div className="records-columns"><RecordList title="购买记录" loading={purchases.isLoading} rows={(purchases.data || []).map((item) => ({ id: item.id, title: item.package_name_snapshot || "积分套餐", amount: `+${item.credits_granted || 0} 积分`, status: item.status, time: item.purchased_at || item.created_at }))} /><RecordList title="消耗记录" loading={consumptions.isLoading} rows={(consumptions.data || []).map((item) => ({ id: item.id, title: item.model_alias || item.description || item.category, amount: `-${item.credits_consumed} 积分`, status: item.status, time: item.occurred_at }))} /></div>
  </div>;
}

function RecordList({ title, loading, rows }: { title: string; loading: boolean; rows: Array<{ id: string; title: string; amount: string; status: string; time?: string }> }) {
  const { locale } = useI18n();
  return <section className="record-list"><header><strong>{title}</strong><span>{rows.length} 条</span></header>{loading ? <div className="account-loading"><LoaderCircle className="spin" /></div> : rows.length ? rows.map((row) => <article key={row.id}><div><strong>{row.title}</strong><small>{date(row.time)}</small></div><div><b>{row.amount}</b><span className={`platform-status ${taskTone(row.status)}`}>{localizedStatusLabel(row.status, locale)}</span></div></article>) : <div className="account-empty">暂无记录</div>}</section>;
}

function PaymentDialog({ purchase, onClose }: { purchase: PlatformPurchase; onClose: () => void }) {
  const { locale } = useI18n();
  const expiryTime = purchase.expires_at ? new Date(purchase.expires_at).getTime() : null;
  const remaining = () => expiryTime === null || !Number.isFinite(expiryTime) ? null : Math.max(0, Math.ceil((expiryTime - Date.now()) / 1000));
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(remaining);
  useEffect(() => {
    setRemainingSeconds(remaining());
    if (expiryTime === null || !Number.isFinite(expiryTime) || terminalPurchaseStatuses.includes(purchase.status)) return;
    const timer = window.setInterval(() => setRemainingSeconds(remaining()), 1000);
    return () => window.clearInterval(timer);
  }, [expiryTime, purchase.status]);
  const effectiveStatus = !terminalPurchaseStatuses.includes(purchase.status) && remainingSeconds === 0 ? "EXPIRED" : purchase.status;
  const paid = effectiveStatus === "PAID";
  const scannable = Boolean(purchase.code_url) && !terminalPurchaseStatuses.includes(effectiveStatus) && remainingSeconds !== 0;
  return <div className="modal-backdrop payment-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="payment-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-dialog-title">
      <header><div><span className="eyebrow">WECHAT PAY</span><h2 id="payment-dialog-title">微信扫码支付</h2><p>{purchase.package_name_snapshot || "积分购买订单"}</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭支付弹窗"><X size={18} /></button></header>
      <div className="payment-dialog-body">
        <div className={`payment-qr-panel${paid ? " paid" : ""}`}>{scannable ? <QRCodeSVG value={purchase.code_url!} size={210} level="M" /> : paid ? <CheckCircle2 size={76} /> : <Clock3 size={70} />}</div>
        <div className="payment-dialog-details">
          <span className={`platform-status ${taskTone(effectiveStatus)}`}>{localizedStatusLabel(effectiveStatus, locale)}</span>
          <strong>{paid ? "支付成功，积分已到账" : effectiveStatus === "EXPIRED" ? "支付二维码已过期" : "请使用微信扫描二维码完成支付"}</strong>
          <p>{paid ? "您可以关闭弹窗并继续使用积分。" : effectiveStatus === "EXPIRED" ? "请关闭弹窗后重新选择套餐生成新的二维码。" : "支付结果会自动刷新，请不要重复下单。"}</p>
          <div className={`payment-countdown${remainingSeconds === 0 ? " expired" : ""}`}><span>支付剩余时间</span><b>{countdownText(remainingSeconds)}</b></div>
          <dl><div><dt>支付金额</dt><dd>{money(purchase.paid_amount_fen ?? purchase.amount_fen)}</dd></div><div><dt>到账积分</dt><dd>{purchase.credits_granted ?? purchase.credits ?? "—"}</dd></div><div><dt>订单编号</dt><dd>{purchase.out_trade_no || purchase.purchase_no || "—"}</dd></div></dl>
        </div>
      </div>
      <footer><span>{paid ? "支付已确认" : "关闭弹窗不会自动取消微信支付订单。"}</span><button className={paid ? "primary-button" : "secondary-button"} type="button" onClick={onClose}>{paid ? "完成并关闭" : "关闭弹窗"}</button></footer>
    </section>
  </div>;
}
