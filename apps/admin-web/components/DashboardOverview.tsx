"use client";

import { Children, useCallback, useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { apiRequest } from "@/lib/api";
import { useProductBrand } from "@/components/ProductBrand";

type TrendPoint = { date: string; value: number; secondary: number };
type RecentInvitation = { id: string; status: string; credits: number; created_at: string; inviter_name: string; invited_name: string };
type RecentCommission = { id: string; level: number; amount_fen: number; created_at: string; beneficiary_name: string; payer_name: string };
type RecentWithdrawal = { id: string; status: string; amount_fen: number; created_at: string; user_name: string };
type RecentPayout = { id: string; amount_fen: number; created_at: string; user_name: string; operator_name: string };

type DashboardData = {
  users: number;
  new_users_30d: number;
  active_tasks: number;
  paid_orders: number;
  revenue_fen: number;
  invitations: { total: number; last_30d: number; pending: number; rewarded: number; limited: number; reward_credits: number };
  commissions: { records: number; total_fen: number; direct_fen: number; indirect_fen: number; last_30d_fen: number; available_fen: number; frozen_fen: number };
  withdrawals: { total: number; pending: number; approved: number; processing: number; rejected: number; paid: number; requested_fen: number; waiting_fen: number };
  payouts: { total: number; total_fen: number; last_30d_count: number; last_30d_fen: number };
  revenue_trend: Array<{ date: string; revenue_fen: number; paid_orders: number }>;
  user_growth_trend: Array<{ date: string; new_users: number; total_users: number }>;
  recent: { invitations: RecentInvitation[]; commissions: RecentCommission[]; withdrawals: RecentWithdrawal[]; payouts: RecentPayout[] };
  generated_at: string;
};

const statusNames: Record<string, string> = {
  PENDING_PAYMENT: "待首购", REWARDED: "已奖励", LIMITED: "受限",
  PENDING: "待审核", APPROVED: "待打款", PROCESSING: "打款中", REJECTED: "已驳回", PAID: "已打款",
};

function money(fen: number) {
  return `¥${(Number(fen || 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function compact(value: number) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function shortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function tone(status: string) {
  return ["REWARDED", "PAID"].includes(status) ? "good" : ["LIMITED", "REJECTED"].includes(status) ? "bad" : "warn";
}

function TrendChart({ eyebrow, title, data, color, valueLabel, secondaryLabel, formatValue }: {
  eyebrow: string; title: string; data: TrendPoint[]; color: string; valueLabel: string; secondaryLabel: string; formatValue: (value: number) => string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const [activeIndex, setActiveIndex] = useState(Math.max(0, data.length - 1));
  const values = data.map((item) => Number(item.value || 0));
  const maximum = Math.max(1, ...values);
  const points = data.map((item, index) => ({
    ...item,
    x: 14 + index * (572 / Math.max(1, data.length - 1)),
    y: 110 - (Number(item.value || 0) / maximum) * 88,
  }));
  const line = points.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const area = points.length ? `${line} L ${points.at(-1)!.x.toFixed(2)} 114 L ${points[0]!.x.toFixed(2)} 114 Z` : "";
  const active = points[Math.min(activeIndex, Math.max(0, points.length - 1))];
  const total = values.reduce((sum, value) => sum + value, 0);
  return <article className="dashboard-chart" style={{ "--chart-color": color } as CSSProperties}>
    <header><div><span>{eyebrow}</span><strong>{title}</strong></div><div className="chart-reading"><b>{active ? formatValue(active.value) : "—"}</b><small>{active?.date.slice(5) || "—"} · {valueLabel}</small></div></header>
    <svg viewBox="0 0 600 125" role="img" aria-label={`${title}最近30天折线图`}>
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".34"/><stop offset="1" stopColor={color} stopOpacity="0"/></linearGradient><filter id={`${gradientId}-glow`}><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      {[22, 66, 110].map((y) => <line key={y} className="chart-gridline" x1="14" y1={y} x2="586" y2={y}/>)}
      {area && (
        <path d={area} fill={`url(#${gradientId})`}/>
      )}
      {line && (
        <path className="chart-line" d={line}/>
      )}
      {active && <><line className="chart-cursor" x1={active.x} y1="17" x2={active.x} y2="114"/><circle className="chart-point-halo" cx={active.x} cy={active.y} r="8"/><circle className="chart-point" cx={active.x} cy={active.y} r="3.5" filter={`url(#${gradientId}-glow)`}/></>}
      {points.map((point, index) => <rect key={point.date} className="chart-hit" x={Math.max(0, point.x - 10)} y="10" width="20" height="108" onMouseEnter={() => setActiveIndex(index)}><title>{point.date}：{formatValue(point.value)}，{secondaryLabel}{compact(point.secondary)}</title></rect>)}
    </svg>
    <footer><span>{data[0]?.date.slice(5) || "—"}</span><span>30 天合计 {formatValue(total)}</span><span>{data.at(-1)?.date.slice(5) || "—"}</span></footer>
  </article>;
}

function MiniMetric({ label, value }: { label: string; value: string | number }) {
  return <div className="dashboard-mini-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function RecentList({ children, empty = "暂无记录" }: { children: ReactNode; empty?: string }) {
  return <div className="dashboard-recent-list">{Children.count(children) ? children : <div className="dashboard-empty">{empty}</div>}</div>;
}

export function DashboardOverview({ token }: { token: string }) {
  const productBrand = useProductBrand();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError("");
    try { setData(await apiRequest<DashboardData>("/admin/dashboard/overview", {}, token)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "运营数据读取失败"); }
    finally { setRefreshing(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  if (error && !data) return <div className="form-error dashboard-load-error">{error}<button className="secondary" onClick={() => void load()}>重新读取</button></div>;
  if (!data) return <div className="loading-card dashboard-loading"><span className="spinner"/>正在汇总运营数据…</div>;

  const revenueTrend = data.revenue_trend.map((item) => ({ date: item.date, value: item.revenue_fen, secondary: item.paid_orders }));
  const growthTrend = data.user_growth_trend.map((item) => ({ date: item.date, value: item.new_users, secondary: item.total_users }));
  const revenue30d = revenueTrend.reduce((sum, item) => sum + item.value, 0);
  const kpis = [
    ["总用户", compact(data.users), `近30天 +${compact(data.new_users_30d)}`, "用"],
    ["进行中创作", compact(data.active_tasks), "实时任务", "创"],
    ["付费订单", compact(data.paid_orders), "累计支付", "单"],
    ["累计收入", money(data.revenue_fen), `近30天 ${money(revenue30d)}`, "收"],
    ["邀请关系", compact(data.invitations.total), `近30天 +${compact(data.invitations.last_30d)}`, "邀"],
    ["累计分润", money(data.commissions.total_fen), `${compact(data.commissions.records)} 笔`, "润"],
    ["待处理提现", compact(data.withdrawals.pending + data.withdrawals.approved + data.withdrawals.processing), money(data.withdrawals.waiting_fen), "提"],
    ["累计打款", money(data.payouts.total_fen), `${compact(data.payouts.total)} 笔`, "付"],
  ];

  return <div className="dashboard-shell">
    <section className="dashboard-hero"><div><span className="kicker">BUSINESS COMMAND CENTER</span><h2>{productBrand.chinese_name}运营驾驶舱</h2><p>用户增长、创作任务、邀请裂变与资金流转，一屏掌握核心经营动态。</p></div><div className="dashboard-hero-summary"><span>近 30 天收入</span><strong>{money(revenue30d)}</strong><small>新增用户 {compact(data.new_users_30d)} · 邀请 {compact(data.invitations.last_30d)}</small></div><button type="button" className="dashboard-refresh" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "刷新中…" : "刷新数据"}</button></section>
    <section className="dashboard-kpis">{kpis.map(([label, value, note, icon]) => <article key={label}><i>{icon}</i><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>)}</section>
    <section className="dashboard-charts">
      <TrendChart eyebrow="REVENUE · 30 DAYS" title="每日收入趋势" data={revenueTrend} color="#cce84d" valueLabel="当日收入" secondaryLabel="支付订单 " formatValue={money}/>
      <TrendChart eyebrow="USER GROWTH · 30 DAYS" title="每日新增用户" data={growthTrend} color="#61d5c2" valueLabel="新增用户" secondaryLabel="累计用户 " formatValue={compact}/>
    </section>
    <section className="dashboard-business-grid">
      <article className="dashboard-business-card invitation"><header><div><span>邀请数据</span><strong>{compact(data.invitations.total)} <small>组关系</small></strong></div><b>邀</b></header><div className="dashboard-mini-grid"><MiniMetric label="近30天" value={data.invitations.last_30d}/><MiniMetric label="已奖励" value={data.invitations.rewarded}/><MiniMetric label="待首购" value={data.invitations.pending}/><MiniMetric label="受限邀请" value={data.invitations.limited}/><MiniMetric label="奖励积分" value={compact(data.invitations.reward_credits)}/></div><RecentList>{data.recent.invitations.map((item) => <div className="dashboard-recent" key={item.id}><div><strong>{item.invited_name}</strong><small>{item.inviter_name} 邀请 · {shortDate(item.created_at)}</small></div><span className={`dashboard-status ${tone(item.status)}`}>{statusNames[item.status] || item.status}</span><b>+{item.credits}</b></div>)}</RecentList></article>
      <article className="dashboard-business-card commission"><header><div><span>分润数据</span><strong>{money(data.commissions.total_fen)} <small>累计</small></strong></div><b>润</b></header><div className="dashboard-mini-grid"><MiniMetric label="分润笔数" value={data.commissions.records}/><MiniMetric label="近30天" value={money(data.commissions.last_30d_fen)}/><MiniMetric label="一级分润" value={money(data.commissions.direct_fen)}/><MiniMetric label="二级分润" value={money(data.commissions.indirect_fen)}/><MiniMetric label="可提现" value={money(data.commissions.available_fen)}/><MiniMetric label="已冻结" value={money(data.commissions.frozen_fen)}/></div><RecentList>{data.recent.commissions.map((item) => <div className="dashboard-recent" key={item.id}><div><strong>{item.beneficiary_name}</strong><small>{item.level === 1 ? "一级" : "二级"} · {item.payer_name} · {shortDate(item.created_at)}</small></div><span>{money(item.amount_fen)}</span></div>)}</RecentList></article>
      <article className="dashboard-business-card withdrawal"><header><div><span>提现申请</span><strong>{money(data.withdrawals.requested_fen)} <small>{compact(data.withdrawals.total)} 笔</small></strong></div><b>提</b></header><div className="dashboard-mini-grid"><MiniMetric label="待处理金额" value={money(data.withdrawals.waiting_fen)}/><MiniMetric label="待审核" value={data.withdrawals.pending}/><MiniMetric label="待打款" value={data.withdrawals.approved}/><MiniMetric label="打款中" value={data.withdrawals.processing}/><MiniMetric label="已打款" value={data.withdrawals.paid}/><MiniMetric label="已驳回" value={data.withdrawals.rejected}/></div><RecentList>{data.recent.withdrawals.map((item) => <div className="dashboard-recent" key={item.id}><div><strong>{item.user_name}</strong><small>{shortDate(item.created_at)} · {money(item.amount_fen)}</small></div><span className={`dashboard-status ${tone(item.status)}`}>{statusNames[item.status] || item.status}</span></div>)}</RecentList></article>
      <article className="dashboard-business-card payout"><header><div><span>打款数据</span><strong>{money(data.payouts.total_fen)} <small>累计</small></strong></div><b>付</b></header><div className="dashboard-mini-grid"><MiniMetric label="累计笔数" value={data.payouts.total}/><MiniMetric label="近30天笔数" value={data.payouts.last_30d_count}/><MiniMetric label="近30天金额" value={money(data.payouts.last_30d_fen)}/></div><RecentList>{data.recent.payouts.map((item) => <div className="dashboard-recent" key={item.id}><div><strong>{item.user_name}</strong><small>{item.operator_name} · {shortDate(item.created_at)}</small></div><span>{money(item.amount_fen)}</span></div>)}</RecentList></article>
    </section>
  </div>;
}
