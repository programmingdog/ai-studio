import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, LoaderCircle, Wallet } from "lucide-react";
import { applyReferralWithdrawal, getReferralRecords, getReferralSummary, type ReferralSummary } from "../services/platform";

const MAX_RECEIPT_IMAGE_BYTES = 2 * 1024 * 1024;
const money = (fen: number | string | undefined) => `¥${(Number(fen || 0) / 100).toFixed(2)}`;
const statusName = (status?: string) => ({ PENDING: "待审核", APPROVED: "已通过，待打款", PROCESSING: "管理员打款处理中", REJECTED: "已驳回", PAID: "已打款" }[status || ""] || status || "已入账");
const rewardStatusName = (status?: string) => ({ PENDING_PAYMENT: "待首笔实付", REWARDED: "已发放", LIMITED: "未发放" }[status || ""] || status || "已发放");

export function InvitationCard({ userId }: { userId: string }) {
  const summary = useQuery({ queryKey: ["referral-summary", userId], queryFn: getReferralSummary });
  const [copied, setCopied] = useState("");
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); setCopied("已复制"); } catch { setCopied("复制失败，请选中文本手动复制"); } };
  return <section className="invitation-card"><h3>邀请好友</h3>
    {summary.error && <div className="error-banner">{String(summary.error)}</div>}
    {!summary.data ? <p>正在读取邀请信息…</p> : <>
      <p>{summary.data.invitation_anti_abuse_enabled ? `好友通过邀请页注册并完成首笔真实支付后，赠送你 ${summary.data.invitation_reward_credits} 积分。` : `每邀请一位新用户完成注册，赠送你 ${summary.data.invitation_reward_credits} 积分。`} 好友先通过邀请页注册绑定，再下载安装客户端。</p>
      <label>我的邀请码<div className="invitation-copy"><input readOnly value={summary.data.invite_code} /><button type="button" className="secondary-button" onClick={() => void copy(summary.data!.invite_code)}><Copy size={15} />复制</button></div></label>
      <label>邀请链接<div className="invitation-copy"><input readOnly value={summary.data.invitation_url} /><button type="button" className="secondary-button" onClick={() => void copy(summary.data!.invitation_url)}><Copy size={15} />复制链接</button></div></label>
      <small>已邀请 {summary.data.invited_count} 人 · 累计奖励 {summary.data.reward_credits} 积分</small>
    </>}{copied && <small role="status">{copied}</small>}
  </section>;
}

export function ReferralPanel({ userId }: { userId?: string }) {
  const summary = useQuery({ queryKey: ["referral-summary", userId], queryFn: getReferralSummary, refetchInterval: 30000, enabled: Boolean(userId) });
  const [kind, setKind] = useState("commissions"), [page, setPage] = useState(1);
  const records = useQuery({ queryKey: ["referral-records", userId, kind, page], queryFn: () => getReferralRecords(kind, page), enabled: Boolean(userId) });
  return <div className="referral-panel">
    {summary.error && <div className="error-banner">{String(summary.error)}</div>}
    {!summary.data ? <div className="account-loading"><LoaderCircle className="spin" />正在读取分润账户…</div> : <>
      <div className="balance-grid"><article><span>可提现金额</span><strong>{money(summary.data.available_fen)}</strong></article><article><span>提现冻结中</span><strong>{money(summary.data.frozen_fen)}</strong></article><article><span>累计已打款</span><strong>{money(summary.data.paid_fen)}</strong></article></div>
      <p>累计分润 {money(summary.data.earned_fen)}。{summary.data.enabled ? `当前直接分润 ${summary.data.direct_rate_bps / 100}%，间接分润 ${summary.data.indirect_rate_bps / 100}%，最多两级。` : "分销当前关闭，不产生新分润；已有余额仍可按规则提现。"}分润以积分套餐实付金额计算，与积分余额独立。</p>
      <WithdrawalForm summary={summary.data} />
    </>}
    <div className="referral-tabs">{[["commissions", "分润记录"], ["withdrawals", "提现申请"], ["payouts", "打款记录"], ["rewards", "邀请奖励"]].map(([key, title]) => <button type="button" key={key} className={kind === key ? "active" : ""} onClick={() => { setKind(key!); setPage(1); }}>{title}</button>)}</div>
    {records.error && <div className="error-banner">{String(records.error)}</div>}
    <div className="referral-records">{records.isLoading ? <p>正在读取记录…</p> : !records.data?.items.length ? <p>暂无记录</p> : records.data.items.map(row => <article key={row.id}><div><strong>{kind === "rewards" ? `邀请奖励 ${row.credits} 积分 · ${rewardStatusName(row.status)}` : `${money(row.amount_fen)} · ${row.level ? `${row.level === 1 ? "直接" : "间接"}分润` : statusName(row.status)}`}</strong><small>{new Date(row.created_at).toLocaleString("zh-CN")}</small>{row.base_amount_fen !== undefined && <small>实付基数 {money(row.base_amount_fen)} × {Number(row.rate_bps) / 100}%</small>}{(row.review_note || row.status_note) && <small>说明：{row.review_note || row.status_note}</small>}{row.alipay_trade_no && <small>支付宝流水：{row.alipay_trade_no}</small>}</div><code>{row.id}</code></article>)}</div>
    <div className="referral-pagination"><button className="secondary-button" disabled={page <= 1 || records.isFetching} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} 页</span><button className="secondary-button" disabled={!records.data?.has_more || records.isFetching} onClick={() => setPage(value => value + 1)}>下一页</button></div>
  </div>;
}

function WithdrawalForm({ summary }: { summary: ReferralSummary }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(""), [name, setName] = useState(""), [account, setAccount] = useState(""), [qr, setQr] = useState("");
  const [fileError, setFileError] = useState(""), [reading, setReading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestKey = useRef(crypto.randomUUID()), busyRef = useRef(false), fileVersion = useRef(0);
  useEffect(() => () => { fileVersion.current++; }, []);
  const mutation = useMutation({ mutationFn: applyReferralWithdrawal, onSuccess: async () => {
    requestKey.current = crypto.randomUUID(); setAmount(""); setName(""); setAccount(""); setQr(""); setConfirmed(false);
    if (fileInput.current) fileInput.current.value = "";
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["referral-summary"] }), queryClient.invalidateQueries({ queryKey: ["referral-records"] })]);
  }, onSettled: () => { busyRef.current = false; } });
  const changed = () => { requestKey.current = crypto.randomUUID(); mutation.reset(); };
  const chooseImage = (file?: File) => {
    const version = ++fileVersion.current;
    changed(); setQr(""); setFileError(""); setReading(false);
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > MAX_RECEIPT_IMAGE_BYTES) { setFileError("请选择不超过 2MB 的 PNG/JPEG 支付宝收款码"); return; }
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => { if (version === fileVersion.current) { setQr(String(reader.result)); setReading(false); } };
    reader.onerror = () => { if (version === fileVersion.current) { setFileError("图片读取失败"); setReading(false); } };
    reader.readAsDataURL(file);
  };
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  const fen = parts ? Number(parts[1]) * 100 + Number((parts[2] || "").padEnd(2, "0")) : 0;
  const valid = Number.isSafeInteger(fen) && fen >= summary.minimum_withdrawal_fen && fen <= summary.available_fen && fen <= 1_000_000_000 && name.trim() && account.trim() && qr && confirmed;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || reading || !valid || !summary.withdrawal_open) return;
    busyRef.current = true;
    mutation.mutate({ amount_fen: fen, idempotency_key: requestKey.current, alipay_real_name: name.trim(), alipay_account: account.trim(), alipay_qr_code: qr });
  };
  return <form className="withdrawal-form" onSubmit={submit}><h3><Wallet size={18} />申请提现</h3><p>每周五北京时间 00:00～24:00 开放，最低 {money(summary.minimum_withdrawal_fen)}。申请后冻结金额，由管理员审核并通过支付宝手动打款。</p>
    {!summary.withdrawal_open && <small>下次开放：{new Date(summary.next_open_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）</small>}
    <fieldset disabled={mutation.isPending}>
      <div className="profile-grid"><label>提现金额（元）<input inputMode="decimal" value={amount} onChange={e => { changed(); setAmount(e.target.value); }} placeholder="0.00" required /></label><label>支付宝实名<input value={name} maxLength={100} onChange={e => { changed(); setName(e.target.value); }} autoComplete="off" required /></label></div>
      <label>支付宝账号<input value={account} maxLength={191} onChange={e => { changed(); setAccount(e.target.value); }} autoComplete="off" required /></label>
      <label>支付宝收款码（PNG/JPEG，≤2MB）<input ref={fileInput} type="file" accept="image/png,image/jpeg" onChange={e => chooseImage(e.target.files?.[0])} /></label>
      {qr && <img className="withdrawal-qr-preview" src={qr} alt="待提交的支付宝收款码" />}
      <label className="withdrawal-confirm"><input type="checkbox" checked={confirmed} onChange={e => { changed(); setConfirmed(e.target.checked); }} />我已核对实名、账号与收款码，确认向平台提交这些收款资料用于人工打款。</label>
    </fieldset>
    {fileError && <div className="error-banner">{fileError}</div>}{mutation.error && <div className="error-banner">{String(mutation.error)}</div>}{mutation.isSuccess && <div className="settings-success">申请已提交，金额已冻结，请等待审核。</div>}
    <small>收款资料加密保存，仅授权的打款管理员可查看。提交失败且结果不明时，请先检查申请记录，未修改资料直接重试不会重复扣款。</small>
    <button className="primary-button" disabled={mutation.isPending || reading || !valid || !summary.withdrawal_open}>{mutation.isPending ? "正在提交…" : "提交提现申请"}</button>
  </form>;
}
