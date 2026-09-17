"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/api";

type Metric = {
  cash_revenue_fen: number; recognized_revenue_fen: number; model_cost_fen: number; gross_profit_fen: number;
  commission_fen: number; net_profit_fen: number; payout_fen: number; consumed_credits: number;
  consumption_count: number; paid_orders: number; unpriced_credits: number; unpriced_records: number;
};
type Trend = Metric & { date?: string; period?: string };
type Breakdown = { name: string; consumption_count: number; consumed_credits: number; recognized_revenue_fen: number; model_cost_fen: number; gross_profit_fen: number; unpriced_records: number };
type FinancialData = {
  periods: { today: Metric; current_week: Metric; current_month: Metric; last_30_days: Metric; all_time: Metric };
  trends: { daily: Trend[]; weekly: Trend[]; monthly: Trend[] };
  breakdown: { categories: Breakdown[]; capabilities: Breakdown[] };
  liabilities: { commission_available_fen: number; commission_frozen_fen: number; withdrawal_waiting_fen: number };
  accounting_note: string; generated_at: string;
};

const periodNames = { today: "今日", current_week: "本周", current_month: "本月", last_30_days: "近 30 天", all_time: "累计" } as const;
const capabilityNames: Record<string, string> = { TEXT_GENERATION: "文本生成", IMAGE_GENERATION: "图片生成", VIDEO_GENERATION: "视频生成", VIDEO_UNDERSTANDING: "视频理解", SCRIPT_LIBRARY: "剧本库", MODEL_TASK: "模型任务" };
const money = (fen: number) => `¥${(Number(fen || 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = (value: number) => Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });

function MetricCards({ metric }: { metric: Metric }) {
  const cards = [
    ["现金总收入", money(metric.cash_revenue_fen), `${number(metric.paid_orders)} 笔已支付订单`],
    ["消耗确认收入", money(metric.recognized_revenue_fen), `${number(metric.consumed_credits)} 积分`],
    ["模型成本", money(metric.model_cost_fen), "按任务创建时成本快照"],
    ["扣分润前毛利", money(metric.gross_profit_fen), "确认收入 - 模型成本"],
    ["全部分润", money(metric.commission_fen), "一级、二级等全部分润"],
    ["扣分润后净利润", money(metric.net_profit_fen), "毛利 - 全部分润"],
  ];
  return <section className="financial-kpis">{cards.map(([label, value, note], index) => <article key={label} className={index === 5 ? "profit" : ""}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>)}</section>;
}

function PeriodTable({ periods }: { periods: FinancialData["periods"] }) {
  return <section className="financial-panel"><header><div><span>PERIOD SUMMARY</span><h3>日 / 周 / 月 / 累计经营汇总</h3></div></header><div className="financial-table-wrap"><table><thead><tr><th>周期</th><th>现金收入</th><th>确认收入</th><th>模型成本</th><th>毛利</th><th>分润</th><th>净利润</th><th>消耗积分</th><th>未计价记录</th></tr></thead><tbody>{Object.entries(periodNames).map(([key, label]) => { const item = periods[key as keyof typeof periods]; return <tr key={key}><th>{label}</th><td>{money(item.cash_revenue_fen)}</td><td>{money(item.recognized_revenue_fen)}</td><td>{money(item.model_cost_fen)}</td><td>{money(item.gross_profit_fen)}</td><td>{money(item.commission_fen)}</td><td className={item.net_profit_fen >= 0 ? "positive" : "negative"}>{money(item.net_profit_fen)}</td><td>{number(item.consumed_credits)}</td><td>{number(item.unpriced_records)}</td></tr>; })}</tbody></table></div></section>;
}

function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }) {
  return <section className="financial-panel financial-breakdown"><header><div><span>BREAKDOWN</span><h3>{title}</h3></div></header><div className="financial-table-wrap"><table><thead><tr><th>项目</th><th>次数</th><th>消耗积分</th><th>确认收入</th><th>成本</th><th>毛利</th><th>未计价</th></tr></thead><tbody>{rows.map((item) => <tr key={item.name}><th>{capabilityNames[item.name] || item.name}</th><td>{number(item.consumption_count)}</td><td>{number(item.consumed_credits)}</td><td>{money(item.recognized_revenue_fen)}</td><td>{money(item.model_cost_fen)}</td><td>{money(item.gross_profit_fen)}</td><td>{number(item.unpriced_records)}</td></tr>)}</tbody></table></div></section>;
}

export function FinancialOverview({ token }: { token: string }) {
  const [data, setData] = useState<FinancialData | null>(null);
  const [error, setError] = useState("");
  const [range, setRange] = useState<"daily" | "weekly" | "monthly">("daily");
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => { setRefreshing(true); setError(""); try { setData(await apiRequest<FinancialData>("/admin/dashboard/financials", {}, token)); } catch (reason) { setError(reason instanceof Error ? reason.message : "财务数据读取失败"); } finally { setRefreshing(false); } }, [token]);
  useEffect(() => { void load(); }, [load]);
  const trend = useMemo(() => data ? data.trends[range].slice(range === "daily" ? -30 : undefined) : [], [data, range]);
  if (error && !data) return <div className="form-error dashboard-load-error">{error}<button className="secondary" onClick={() => void load()}>重新读取</button></div>;
  if (!data) return <div className="loading-card dashboard-loading"><span className="spinner"/>正在核算收入、成本与分润…</div>;
  return <div className="financial-shell">
    <section className="financial-hero"><div><span className="kicker">FINANCIAL CONTROL CENTER</span><h2>经营财务与合伙人分账</h2><p>{data.accounting_note}</p></div><button className="secondary" disabled={refreshing} onClick={() => void load()}>{refreshing ? "核算中…" : "刷新核算"}</button></section>
    <MetricCards metric={data.periods.all_time}/>
    <section className="financial-liabilities"><article><span>可提现分润负债</span><strong>{money(data.liabilities.commission_available_fen)}</strong></article><article><span>冻结中分润</span><strong>{money(data.liabilities.commission_frozen_fen)}</strong></article><article><span>待处理提现</span><strong>{money(data.liabilities.withdrawal_waiting_fen)}</strong></article><article><span>累计已打款</span><strong>{money(data.periods.all_time.payout_fen)}</strong><small>不重复扣减利润</small></article></section>
    <PeriodTable periods={data.periods}/>
    <section className="financial-panel"><header><div><span>TRENDS</span><h3>经营趋势明细</h3></div><nav>{(["daily", "weekly", "monthly"] as const).map((item) => <button key={item} className={range === item ? "active" : ""} onClick={() => setRange(item)}>{item === "daily" ? "按日" : item === "weekly" ? "按周" : "按月"}</button>)}</nav></header><div className="financial-table-wrap"><table><thead><tr><th>周期</th><th>现金收入</th><th>确认收入</th><th>模型成本</th><th>全部分润</th><th>扣分润后净利润</th><th>消耗次数</th></tr></thead><tbody>{trend.map((item) => <tr key={item.date || item.period}><th>{item.date || item.period}</th><td>{money(item.cash_revenue_fen)}</td><td>{money(item.recognized_revenue_fen)}</td><td>{money(item.model_cost_fen)}</td><td>{money(item.commission_fen)}</td><td className={item.net_profit_fen >= 0 ? "positive" : "negative"}>{money(item.net_profit_fen)}</td><td>{number(item.consumption_count)}</td></tr>)}</tbody></table></div></section>
    <div className="financial-breakdown-grid"><BreakdownTable title="按业务分类" rows={data.breakdown.categories}/><BreakdownTable title="按模型能力" rows={data.breakdown.capabilities}/></div>
  </div>;
}
