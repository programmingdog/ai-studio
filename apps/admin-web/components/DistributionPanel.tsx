"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { apiRequest } from "@/lib/api";

type Config = { enabled: boolean; direct_rate_bps: number; indirect_rate_bps: number; minimum_withdrawal_fen: number; invitation_reward_credits: number; invitation_anti_abuse_enabled: boolean; invitation_daily_reward_limit: number; invitation_monthly_reward_limit: number; invite_page_base_url: string; windows_download_url: string; macos_download_url: string; revision: number };
type Row = { id: string; user_id?: string; beneficiary_id?: string; inviter_id?: string; invited_user_id?: string; payer_id?: string; amount_fen?: number; base_amount_fen?: number; rate_bps?: number; level?: number; credits?: number; status?: string; status_note?: string; created_at: string; review_note?: string; alipay_trade_no?: string; withdrawal_id?: string; payment_order_id?: string; qualified_payment_order_id?: string };
type Page = { items: Row[]; page: number; has_more: boolean };
type Payee = Row & { alipay_real_name: string; alipay_account: string; alipay_qr_code: string; can_confirm: boolean; processing_by?: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const money = (value: number | undefined) => `¥${(Number(value || 0) / 100).toFixed(2)}`;
const statusName = (value?: string) => ({ PENDING: "待审核", APPROVED: "已通过，待打款", PROCESSING: "已领取，打款处理中", REJECTED: "已驳回", PAID: "已打款" }[value || ""] || value || "已入账");
const rewardStatusName = (value?: string) => ({ PENDING_PAYMENT: "待首笔实付", REWARDED: "已发放", LIMITED: "未发放" }[value || ""] || value || "已发放");
const decimalUnits = (value: string) => {
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!parts) throw new Error("金额和比例最多两位小数");
  return Number(parts[1]) * 100 + Number((parts[2] || "").padEnd(2, "0"));
};

export function DistributionConfigPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<Config | null>(null), [error, setError] = useState(""), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false);
  const [direct, setDirect] = useState("0"), [indirect, setIndirect] = useState("0"), [minimum, setMinimum] = useState("100");
  const load = useCallback(async () => {
    setBusy(true); setError(""); setSaved(false);
    try { const data = await apiRequest<Config>("/admin/distribution/config", {}, token); setConfig(data); setDirect((data.direct_rate_bps / 100).toString()); setIndirect((data.indirect_rate_bps / 100).toString()); setMinimum((data.minimum_withdrawal_fen / 100).toFixed(2)); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!config || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try { setConfig(await apiRequest<Config>("/admin/distribution/config", { method: "PATCH", body: JSON.stringify({ ...config, direct_rate_bps: decimalUnits(direct), indirect_rate_bps: decimalUnits(indirect), minimum_withdrawal_fen: decimalUnits(minimum) }) }, token)); setSaved(true); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  return <section className="section-card distribution-config"><header><div><span className="kicker">REFERRALS & COMMISSION</span><h2>分销与邀请配置</h2><p>最多两级，按积分套餐实际支付金额计提。配置变更仅影响后续入账，不重算历史记录。</p></div></header>
    {error && <div className="form-error">{error}</div>}{saved && <p className="distribution-success" role="status">配置已保存</p>}
    {!config ? <p>正在读取配置…</p> : <form onSubmit={save}><fieldset disabled={busy}>
      <label>分销开关<select value={config.enabled ? "on" : "off"} onChange={e => setConfig({ ...config, enabled: e.target.value === "on" })}><option value="off">关闭（默认）</option><option value="on">开启</option></select></label>
      <div className="two-columns"><label>直接分润比例（%）<input inputMode="decimal" value={direct} onChange={e => setDirect(e.target.value)} required /></label><label>间接分润比例（%）<input inputMode="decimal" value={indirect} onChange={e => setIndirect(e.target.value)} required /></label></div>
      <div className="two-columns"><label>最低提现金额（元）<input inputMode="decimal" value={minimum} onChange={e => setMinimum(e.target.value)} required /></label><label>每邀请一位新用户奖励积分<input type="number" min={0} max={100000} step={1} value={config.invitation_reward_credits} onChange={e => setConfig({ ...config, invitation_reward_credits: Number(e.target.value) })} required /></label></div>
      <label className="distribution-checkbox"><input type="checkbox" checked={config.invitation_anti_abuse_enabled} onChange={e => setConfig({ ...config, invitation_anti_abuse_enabled: e.target.checked })} />开启邀请积分防刷</label>
      <small>{config.invitation_anti_abuse_enabled ? "开启后，新邀请奖励先待确认；被邀请人完成首笔真实支付且未超过限额时才发放。" : "关闭后，沿用注册成功立即发放邀请积分的规则。"}</small>
      <div className="two-columns"><label>每日最多奖励人数<input type="number" min={1} max={100000} step={1} disabled={!config.invitation_anti_abuse_enabled} value={config.invitation_daily_reward_limit} onChange={e => setConfig({ ...config, invitation_daily_reward_limit: Number(e.target.value) })} required /></label><label>每月最多奖励人数<input type="number" min={1} max={1000000} step={1} disabled={!config.invitation_anti_abuse_enabled} value={config.invitation_monthly_reward_limit} onChange={e => setConfig({ ...config, invitation_monthly_reward_limit: Number(e.target.value) })} required /><small>按北京时间统计；月上限不能小于日上限。超过限额的邀请不发放积分。</small></label></div>
      <label>邀请页基础地址<input type="url" maxLength={500} value={config.invite_page_base_url} onChange={e => setConfig({ ...config, invite_page_base_url: e.target.value })} placeholder="https://你的域名/invite" required /><small>填写本网站公开邀请页地址，不带邀请码；系统自动追加 /8位邀请码。公开域名必须在 API 的允许来源中。</small></label>
      <p>提现每周五北京时间开放。关闭分销只停止新分润，不阻止已有余额按规则申请提现。邀请积分与分销开关独立，奖励设为 0 可暂停新邀请奖励。</p>
      <p>分润按整数“分”计算，不足一分舍去；两项比例合计不得超过 100%。仅限制两级不代表模式自动合规，请在启用前完成业务合规审核。</p>
      <div className="table-actions"><button className="primary" disabled={busy}>保存配置</button><button className="secondary" type="button" disabled={busy} onClick={() => void load()}>重新读取</button></div>
    </fieldset></form>}
  </section>;
}

export function DistributionRecordsPanel({ token, kind }: { token: string; kind: "commissions" | "withdrawals" | "payouts" | "rewards" }) {
  const [page, setPage] = useState(1), [status, setStatus] = useState(""), [user, setUser] = useState("");
  const [data, setData] = useState<Page | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState<Row | null>(null), [paying, setPaying] = useState<Payee | null>(null);
  const [openingPayee, setOpeningPayee] = useState(false);
  const loadVersion = useRef(0), payeeLock = useRef(false);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true); setError("");
    try { const result = await apiRequest<Page>(`/admin/distribution/records/${kind}?page=${page}&status=${encodeURIComponent(status)}&user_id=${encodeURIComponent(user.trim())}`, {}, token); if (version === loadVersion.current) setData(result); }
    catch (cause) { if (version === loadVersion.current) setError(message(cause)); } finally { if (version === loadVersion.current) setLoading(false); }
  }, [kind, page, status, token, user]);
  useEffect(() => { void load(); return () => { loadVersion.current++; }; }, [load]);
  const payee = async (row: Row) => {
    if (payeeLock.current) return;
    payeeLock.current = true; setOpeningPayee(true); setError("");
    try {
      if (row.status === "APPROVED") await apiRequest(`/admin/distribution/withdrawals/${row.id}/claim`, { method: "POST" }, token);
      setPaying(await apiRequest<Payee>(`/admin/distribution/withdrawals/${row.id}/payee`, {}, token));
      await load();
    }
    catch (cause) { setError(message(cause)); }
    finally { payeeLock.current = false; setOpeningPayee(false); }
  };
  return <section className="section-card table-card distribution-records"><header><div><span className="kicker">DISTRIBUTION LEDGER</span><h2>{{ commissions: "分润记录", withdrawals: "提现申请", payouts: "打款记录", rewards: "邀请奖励记录" }[kind]}</h2><p>资金记录不可直接修改或删除。提现审核不会自动转账，实际支付由管理员在支付宝中完成。</p></div><button className="secondary" disabled={loading} onClick={() => void load()}>刷新</button></header>
    <div className="distribution-filters"><label>用户 ID<input value={user} onChange={e => { setPage(1); setUser(e.target.value); }} placeholder="按收益用户筛选" /></label>{kind === "withdrawals" && <label>申请状态<select value={status} onChange={e => { setPage(1); setStatus(e.target.value); }}><option value="">全部</option>{["PENDING", "APPROVED", "PROCESSING", "REJECTED", "PAID"].map(item => <option key={item} value={item}>{statusName(item)}</option>)}</select></label>}{kind === "rewards" && <label>奖励状态<select value={status} onChange={e => { setPage(1); setStatus(e.target.value); }}><option value="">全部</option>{["PENDING_PAYMENT", "REWARDED", "LIMITED"].map(item => <option key={item} value={item}>{rewardStatusName(item)}</option>)}</select></label>}</div>
    {error && <div className="form-error">{error}</div>}
    <div className="table-scroll"><table><thead><tr><th>记录 / 用户</th><th>金额 / 奖励</th><th>状态 / 计提依据</th><th>时间</th><th>操作 / 关联记录</th></tr></thead><tbody>{data?.items.map(row => <tr key={row.id}>
      <td><strong>{row.id}</strong><small className="cell-note">{row.user_id || row.beneficiary_id || row.inviter_id}</small></td>
      <td>{kind === "rewards" ? `${row.credits} 积分` : money(row.amount_fen)}</td>
      <td>{row.level ? `${row.level === 1 ? "直接" : "间接"} ${Number(row.rate_bps) / 100}% × ${money(row.base_amount_fen)}` : kind === "rewards" ? rewardStatusName(row.status) : statusName(row.status)}{(row.review_note || row.status_note) && <small className="cell-note">{row.review_note || row.status_note}</small>}</td>
      <td>{new Date(row.created_at).toLocaleString("zh-CN")}</td>
      <td>{kind === "withdrawals" ? <div className="table-actions">{["PENDING", "APPROVED"].includes(row.status || "") && <button className="secondary" disabled={openingPayee} onClick={() => setReviewing(row)}>审核</button>}<button className="secondary" disabled={openingPayee} onClick={() => void payee(row)}>{row.status === "APPROVED" ? "领取打款任务" : row.status === "PROCESSING" ? "查看打款任务" : "查看收款资料"}</button></div> : <small>{row.alipay_trade_no || row.payment_order_id || row.qualified_payment_order_id || row.invited_user_id}{row.withdrawal_id && <span className="cell-note">提现单：{row.withdrawal_id}</span>}</small>}</td>
    </tr>)}</tbody></table>{!data?.items.length && <p className="empty-row">{loading ? "正在读取…" : "暂无记录"}</p>}</div>
    <div className="distribution-pagination"><button className="secondary" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} 页</span><button className="secondary" disabled={!data?.has_more || loading} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    {reviewing && <ReviewDialog token={token} row={reviewing} onClose={() => setReviewing(null)} onSaved={async () => { setReviewing(null); await load(); }} />}
    {paying && <PayoutDialog token={token} row={paying} onClose={() => setPaying(null)} onSaved={async () => { setPaying(null); await load(); }} />}
  </section>;
}

function DistributionDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    dialog.current?.focus();
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="distribution-modal-backdrop"><section ref={dialog} tabIndex={-1} className="distribution-modal" role="dialog" aria-modal="true" aria-label={title} onKeyDown={e => {
    if (e.key === "Escape" && !busy) { e.preventDefault(); onClose(); }
    if (e.key === "Tab") {
      const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (!first) e.preventDefault();
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === e.currentTarget)) { e.preventDefault(); first.focus(); }
    }
  }}><header><h2>{title}</h2><button className="secondary" disabled={busy} onClick={onClose}>关闭</button></header>{children}</section></div>, document.body);
}

function ReviewDialog({ token, row, onClose, onSaved }: { token: string; row: Row; onClose: () => void; onSaved: () => Promise<void> }) {
  const [decision, setDecision] = useState(row.status === "APPROVED" ? "REJECTED" : "APPROVED"), [note, setNote] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try { await apiRequest(`/admin/distribution/withdrawals/${row.id}/review`, { method: "POST", body: JSON.stringify({ decision, note }) }, token); await onSaved(); }
    catch (cause) { setError(message(cause)); } finally { lock.current = false; setBusy(false); }
  };
  return <DistributionDialog title="审核提现申请" busy={busy} onClose={onClose}><form onSubmit={submit}><p>{row.id} · {money(row.amount_fen)}</p><label>审核结果<select disabled={busy} value={decision} onChange={e => setDecision(e.target.value)}>{row.status === "PENDING" && <option value="APPROVED">通过，等待手动打款</option>}<option value="REJECTED">驳回，退回冻结余额</option></select></label><label>审核说明<textarea disabled={busy} value={note} maxLength={500} required={decision === "REJECTED"} onChange={e => setNote(e.target.value)} /></label>{error && <div className="form-error">{error}</div>}<button className="primary" disabled={busy}>提交审核</button></form></DistributionDialog>;
}

function PayoutDialog({ token, row, onClose, onSaved }: { token: string; row: Payee; onClose: () => void; onSaved: () => Promise<void> }) {
  const [trade, setTrade] = useState(""), [note, setNote] = useState(""), [confirmed, setConfirmed] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [notPaid, setNotPaid] = useState(false);
  const lock = useRef(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current || !confirmed) return; lock.current = true; setBusy(true); setError("");
    try { await apiRequest(`/admin/distribution/withdrawals/${row.id}/paid`, { method: "POST", body: JSON.stringify({ alipay_trade_no: trade, note, confirmed }) }, token); await onSaved(); }
    catch (cause) { setError(message(cause)); } finally { lock.current = false; setBusy(false); }
  };
  const release = async () => {
    if (lock.current || !notPaid || confirmed || !note.trim()) return;
    lock.current = true; setBusy(true); setError("");
    try { await apiRequest(`/admin/distribution/withdrawals/${row.id}/release`, { method: "POST", body: JSON.stringify({ not_paid: true, note }) }, token); await onSaved(); }
    catch (cause) { setError(message(cause)); } finally { lock.current = false; setBusy(false); }
  };
  return <DistributionDialog title="提现收款资料与打款" busy={busy} onClose={onClose}><p>{row.id} · {statusName(row.status)}</p><dl><dt>本次应付金额</dt><dd>{money(row.amount_fen)}</dd><dt>支付宝实名</dt><dd>{row.alipay_real_name}</dd><dt>支付宝账号</dt><dd>{row.alipay_account}</dd></dl><img className="distribution-payee-qr" src={row.alipay_qr_code} alt="申请人支付宝收款码" />{row.can_confirm ? <><p>此任务已由你领取。请在支付宝中核对实名、账号及金额后手动打款；本页面不会转账。关闭弹窗不会释放任务，遇到网络错误请先核对支付宝流水，切勿重复转账。</p><form onSubmit={submit}><label>支付宝交易流水号<input disabled={busy || notPaid} value={trade} minLength={6} maxLength={100} onChange={e => setTrade(e.target.value)} required={!notPaid} /></label><label>打款或释放任务说明<textarea disabled={busy} value={note} maxLength={500} onChange={e => setNote(e.target.value)} required /></label><label className="distribution-checkbox"><input type="checkbox" disabled={busy || notPaid} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我确认已完成实际打款，并已核对本申请及支付宝流水。</label>{error && <div className="form-error">{error}</div>}<button className="primary" disabled={busy || !confirmed || notPaid}>确认已打款并记账</button><hr /><label className="distribution-checkbox"><input type="checkbox" disabled={busy || confirmed} checked={notPaid} onChange={e => setNotPaid(e.target.checked)} />我确认尚未实际打款，需要释放任务供重新处理。</label><button className="secondary" type="button" disabled={busy || !notPaid || confirmed || !note.trim()} onClick={() => void release()}>确认未打款，释放任务</button></form></> : <p>当前仅供核对资料，请勿打款。只有领取任务的管理员可以确认打款；未通过审核或已完成的申请不能操作。</p>}</DistributionDialog>;
}
