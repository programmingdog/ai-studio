"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { UserRelationsModal } from "./UserRelationsModal";

type UserRow = {
  id: string;
  pid: string | null;
  invite_code: string;
  balance_fen: number;
  commission_available_fen: number;
  commission_frozen_fen: number;
  direct_count: number;
  indirect_count: number;
  parent: { id: string; display_name: string; email: string | null; phone: string | null; status: string } | null;
  email: string | null;
  phone: string | null;
  display_name: string;
  avatar_url: string | null;
  bio: string;
  status: string;
  credit_balance: number;
  held_credits: number;
  available_credits: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatCredits(value: number): string {
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
}

function formatMoney(fen: number): string { return `¥${(Number(fen || 0) / 100).toFixed(2)}`; }

export function UsersPanel({ token }: { token: string }) {
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [adjusting, setAdjusting] = useState<UserRow | null>(null);
  const [relations, setRelations] = useState<{ userId: string; level: 1 | 2 } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setError("");
      setRows(await apiRequest<UserRow[]>("/admin/users?limit=200", {}, token));
    } catch (reason) {
      setError(errorMessage(reason, "读取用户列表失败"));
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  return <section className="section-card table-card user-table-card">
    <header><div><span className="kicker">USER DIRECTORY</span><h2>用户管理</h2><p>查看积分、分润余额和两级邀请关系。分润余额包含提现冻结金额，实际打款后扣减；人数包含停用账户。</p></div><div className="table-actions"><span className="record-count">{rows?.length ?? 0} 人</span><button className="secondary" onClick={() => void load()}>刷新</button></div></header>
    {error && <div className="form-error">{error}</div>}
    {!rows ? <div className="loading-card"><span className="spinner" />正在读取用户数据…</div> : rows.length ? <div className="table-scroll"><table><thead><tr><th>用户</th><th>联系方式</th><th>分润余额</th><th>上级 / 下级人数</th><th>当前积分</th><th>状态</th><th>最近登录</th><th>注册时间</th><th>操作</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
      <td><strong>{row.display_name || "未命名用户"}</strong><small className="cell-note">{row.id}</small><small className="cell-note">邀请码：{row.invite_code || "待生成"}</small></td>
      <td>{row.email || row.phone || "—"}<small className="cell-note">{row.email && row.phone ? row.phone : ""}</small></td>
      <td><strong className="credit-balance">{formatMoney(row.balance_fen)}</strong><small className="cell-note">可提现 {formatMoney(row.commission_available_fen)}</small><small className="cell-note">冻结 {formatMoney(row.commission_frozen_fen)}</small></td>
      <td>{row.parent ? <button className="user-relation-link" onClick={() => setRelations({ userId: row.parent!.id, level: 1 })}>上级：{row.parent.display_name || row.parent.email || row.parent.phone || row.parent.id}</button> : <span>无上级</span>}{row.pid && <small className="cell-note">{row.pid}</small>}<div className="user-relation-counts"><button className="user-relation-link" onClick={() => setRelations({ userId: row.id, level: 1 })}>直接下级 {row.direct_count || 0} 人</button><button className="user-relation-link" onClick={() => setRelations({ userId: row.id, level: 2 })}>间接下级 {row.indirect_count || 0} 人</button></div></td>
      <td><strong className="credit-balance">{formatCredits(row.credit_balance)}</strong><small className="cell-note">可用 {formatCredits(row.available_credits)} · 占用 {formatCredits(row.held_credits)}</small></td>
      <td><span className={`status ${row.status === "ACTIVE" ? "good" : "bad"}`}>{row.status}</span></td>
      <td>{formatDate(row.last_login_at)}</td><td>{formatDate(row.created_at)}</td>
      <td><div className="table-actions"><button className="secondary" onClick={() => setRelations({ userId: row.id, level: 1 })}>查看上下级</button><button className="secondary" onClick={() => setEditing(row)}>编辑资料</button><button className="secondary credit-action" onClick={() => setAdjusting(row)}>调整积分</button></div></td>
    </tr>)}</tbody></table></div> : <div className="empty-row">还没有用户</div>}
    {editing && <UserEditModal token={token} user={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}
    {adjusting && <CreditAdjustmentModal token={token} user={adjusting} onClose={() => setAdjusting(null)} onSaved={async () => { setAdjusting(null); await load(); }} />}
    {relations && <UserRelationsModal key={`${relations.userId}-${relations.level}`} token={token} userId={relations.userId} initialLevel={relations.level} onClose={() => setRelations(null)} />}
  </section>;
}

function UserEditModal({ token, user, onClose, onSaved }: { token: string; user: UserRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ display_name: user.display_name, email: user.email || "", phone: user.phone || "", avatar_url: user.avatar_url || "", bio: user.bio || "", status: user.status });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await apiRequest(`/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify(form) }, token);
      await onSaved();
    } catch (reason) { setError(errorMessage(reason, "保存用户资料失败")); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="modal model-modal user-edit-modal" onSubmit={submit}><header><div><span className="kicker">EDIT USER</span><h2>编辑用户信息</h2><p>{user.id}</p></div><button type="button" onClick={onClose}>×</button></header>
    <div className="three-columns"><label>显示名称<input value={form.display_name} maxLength={100} onChange={(event) => setForm({ ...form, display_name: event.target.value })} required /></label><label>邮箱<input type="email" value={form.email} maxLength={191} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="可留空" /></label><label>手机号<input value={form.phone} maxLength={32} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="可留空" /></label></div>
    <div className="two-columns"><label>头像 HTTPS 地址<input type="url" value={form.avatar_url} maxLength={1000} onChange={(event) => setForm({ ...form, avatar_url: event.target.value })} placeholder="https://..." /></label><label>账号状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">正常</option><option value="DISABLED">停用</option></select></label></div>
    <label>个人简介<textarea className="compact-textarea" maxLength={500} value={form.bio} onChange={(event) => setForm({ ...form, bio: event.target.value })} /></label>
    <div className="user-edit-warning">停用用户后，其当前登录会话会立即失效；重新启用后可以再次登录。</div>
    {error && <div className="form-error">{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存用户资料"}</button></footer>
  </form></div>;
}

function CreditAdjustmentModal({ token, user, onClose, onSaved }: { token: string; user: UserRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const numericAmount = Number(amount);
  const nextBalance = user.credit_balance + (Number.isFinite(numericAmount) ? numericAmount : 0);
  const invalidAmount = !Number.isSafeInteger(numericAmount) || numericAmount === 0 || nextBalance < user.held_credits;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (invalidAmount) return;
    setSaving(true); setError("");
    try {
      await apiRequest(`/admin/users/${user.id}/credit-adjustments`, { method: "POST", body: JSON.stringify({ amount: numericAmount, reason }) }, token);
      await onSaved();
    } catch (reasonValue) { setError(errorMessage(reasonValue, "调整用户积分失败")); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="modal credit-adjustment-modal" onSubmit={submit}><header><div><span className="kicker">CREDIT ADJUSTMENT</span><h2>调整用户积分</h2><p>{user.display_name || user.email || user.phone || user.id}</p></div><button type="button" onClick={onClose}>×</button></header>
    <div className="credit-adjustment-summary"><article><span>当前积分</span><strong>{formatCredits(user.credit_balance)}</strong></article><article><span>占用积分</span><strong>{formatCredits(user.held_credits)}</strong></article><article><span>调整后积分</span><strong className={nextBalance < user.held_credits ? "invalid" : ""}>{formatCredits(nextBalance)}</strong></article></div>
    <label>调整积分数<input type="number" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="增加填正数，扣减填负数" required /><small>例如：增加 1000 积分填写 1000，扣减 200 积分填写 -200。</small></label>
    <label>调整原因<textarea className="compact-textarea" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="请填写本次人工调整的具体原因" required /></label>
    {nextBalance < user.held_credits && <div className="form-error">调整后积分不能低于当前占用积分 {formatCredits(user.held_credits)}</div>}
    {error && <div className="form-error">{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving || invalidAmount || !reason.trim()}>{saving ? "调整中…" : "确认调整"}</button></footer>
  </form></div>;
}
