"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { apiRequest } from "@/lib/api";

type RelatedUser = { id: string; pid: string | null; invite_code: string; display_name: string; email: string | null; phone: string | null; status: string; balance_fen: number; created_at: string; parent_id?: string; parent_display_name?: string };
type Relations = { user: RelatedUser; parent: RelatedUser | null; direct_count: number; indirect_count: number; items: RelatedUser[]; level: number; page: number; total: number; has_more: boolean };
const money = (fen: number) => `¥${(Number(fen || 0) / 100).toFixed(2)}`;
const name = (user: RelatedUser) => user.display_name || user.email || user.phone || "未命名用户";

export function UserRelationsModal({ token, userId, initialLevel = 1, onClose }: { token: string; userId: string; initialLevel?: 1 | 2; onClose: () => void }) {
  const [selected, setSelected] = useState(userId), [level, setLevel] = useState<1 | 2>(initialLevel), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [history, setHistory] = useState<string[]>([]), [data, setData] = useState<Relations | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    let active = true; const controller = new AbortController();
    setLoading(true); setError(""); setData(null);
    apiRequest<Relations>(`/admin/users/${encodeURIComponent(selected)}/relations?level=${level}&page=${page}`, { signal: controller.signal }, token)
      .then(value => { if (active) setData(value); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "读取上下级失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [selected, level, page, refresh, token]);
  const navigate = (id: string) => { setHistory(value => [...value, selected]); setSelected(id); setLevel(1); setPage(1); };
  const back = () => { const previous = history.at(-1); if (!previous) return; setHistory(value => value.slice(0, -1)); setSelected(previous); setLevel(1); setPage(1); };
  return <RelationsDialog onClose={onClose}>
    <div className="table-actions"><button className="secondary" disabled={!history.length || loading} onClick={back}>返回上一用户</button><button className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新关系</button></div>
    <p className="user-relations-hint">只读展示邀请关系，不能修改上级或余额。人数包含正常和停用账户；间接下级仅统计第二级，不包含第三级。</p>
    {error && <div className="form-error" role="alert">{error}<button className="secondary" onClick={() => setRefresh(value => value + 1)}>重试</button></div>}
    {loading ? <p role="status">正在读取上下级…</p> : data && <>
      <div className="user-relations-summary"><article><span>当前用户</span><strong>{name(data.user)}</strong><small>{data.user.id}</small><small>邀请码：{data.user.invite_code}</small><small>状态：{data.user.status === "ACTIVE" ? "正常" : "停用"}</small></article><article><span>分润余额（含冻结）</span><strong>{money(data.user.balance_fen)}</strong><small>分润到账增加，实际打款后扣减</small></article><article><span>直接下级</span><strong>{data.direct_count} 人</strong><small>一级邀请关系</small></article><article><span>间接下级</span><strong>{data.indirect_count} 人</strong><small>二级邀请关系</small></article></div>
      <section className="user-relations-parent"><h3>上级用户</h3>{data.parent ? <><div><strong>{name(data.parent)}</strong><small className="cell-note">{data.parent.id}</small><small className="cell-note">{data.parent.email || data.parent.phone || "未绑定联系方式"} · {data.parent.status === "ACTIVE" ? "正常" : "停用"}</small></div><button className="secondary" onClick={() => navigate(data.parent!.id)}>查看上级的关系</button></> : <p>该用户没有上级。</p>}</section>
      <div className="table-actions user-relations-tabs"><button className={level === 1 ? "primary" : "secondary"} aria-pressed={level === 1} onClick={() => { setLevel(1); setPage(1); }}>直接下级（{data.direct_count}）</button><button className={level === 2 ? "primary" : "secondary"} aria-pressed={level === 2} onClick={() => { setLevel(2); setPage(1); }}>间接下级（{data.indirect_count}）</button><span>共 {data.total} 人</span></div>
      <div className="table-scroll"><table><thead><tr><th>下级用户</th><th>联系方式</th><th>直属上级</th><th>分润余额</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead><tbody>{data.items.map(user => <tr key={user.id}><td><strong>{name(user)}</strong><small className="cell-note">{user.id}</small><small className="cell-note">邀请码：{user.invite_code}</small></td><td>{user.email || user.phone || "—"}</td><td>{user.parent_display_name || user.parent_id || "—"}<small className="cell-note">{user.parent_id}</small></td><td>{money(user.balance_fen)}</td><td><span className={`status ${user.status === "ACTIVE" ? "good" : "bad"}`}>{user.status === "ACTIVE" ? "正常" : "停用"}</span></td><td>{new Date(user.created_at).toLocaleString("zh-CN", { hour12: false })}</td><td><button className="secondary" onClick={() => navigate(user.id)}>查看此用户关系</button></td></tr>)}</tbody></table>{!data.items.length && <p className="empty-row">暂无{level === 1 ? "直接" : "间接"}下级</p>}</div>
      <div className="distribution-pagination"><button className="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} 页 · 每页 50 人</span><button className="secondary" disabled={!data.has_more} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </>}
  </RelationsDialog>;
}

function RelationsDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden"; ref.current?.focus();
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="distribution-modal-backdrop"><section ref={ref} className="distribution-modal user-relations-modal" role="dialog" aria-modal="true" aria-label="用户上下级" tabIndex={-1} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "Tab") {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first?.focus(); }
    }
  }}><header><div><span className="kicker">INVITATION RELATIONSHIPS</span><h2>用户上下级</h2></div><button className="secondary" type="button" onClick={onClose}>关闭</button></header>{children}</section></div>, document.body);
}
