"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

export type CreditSection = "packages" | "purchases" | "consumptions";

type CreditPackage = {
  id: string; code: string; name: string; description: string; base_credits: number;
  bonus_credits: number; total_credits: number; price_fen: number; currency: string;
  status: string; sort_order: number; created_at: string; updated_at: string;
};
type UserOption = { id: string; email: string | null; phone: string | null; display_name: string; status: string };
type CreditPurchase = {
  id: string; purchase_no: string; user_id: string; user_email: string | null; user_name: string;
  package_id: string | null; package_code_snapshot: string; package_name_snapshot: string;
  base_credits_snapshot: number; bonus_credits_snapshot: number; credits_granted: number;
  paid_amount_fen: number; currency: string; payment_order_id: string | null; status: string;
  purchased_at: string | null; notes: string; created_at: string;
};
type CreditConsumption = {
  id: string; consumption_no: string; user_id: string; user_email: string | null; user_name: string;
  task_id: string | null; provider_model_id: string | null; model_alias: string | null; model_code: string | null;
  category: string; credits_consumed: number; status: string; description: string; notes: string;
  metadata_json: unknown; occurred_at: string; created_at: string;
};

const sectionCopy = {
  packages: { eyebrow: "CREDIT PACKAGES", title: "积分套餐", note: "配置客户端可购买的积分数量、赠送积分与售价。" },
  purchases: { eyebrow: "PURCHASE RECORDS", title: "积分套餐购买记录", note: "管理用户的套餐购买、到账积分和支付状态。" },
  consumptions: { eyebrow: "CONSUMPTION RECORDS", title: "积分消耗记录", note: "记录模型任务、API 测试和人工调整产生的积分消耗。" },
};

function message(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
function formatDate(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function dateTimeLocal(value?: string | null) {
  const date = value ? new Date(value) : new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function asIso(value: string) { return value ? new Date(value).toISOString() : null; }
function tone(status: string) {
  if (["ACTIVE", "PAID", "CONFIRMED"].includes(status)) return "good";
  if (["DISABLED", "CANCELED", "REFUNDED", "REVERSED"].includes(status)) return "bad";
  return "warn";
}
function userLabel(user: UserOption) { return `${user.display_name || "未命名用户"} · ${user.email || user.phone || user.id}`; }

export function CreditsPanel({ token, section }: { token: string; section: CreditSection }) {
  const copy = sectionCopy[section];
  return <>
    <section className="credit-summary"><div><span className="kicker">{copy.eyebrow}</span><h2>{copy.title}</h2><p>{copy.note}</p></div><div className="credit-symbol">C</div></section>
    {section === "packages" && <PackagesManager token={token} />}
    {section === "purchases" && <PurchasesManager token={token} />}
    {section === "consumptions" && <ConsumptionsManager token={token} />}
  </>;
}

function PackagesManager({ token }: { token: string }) {
  const [rows, setRows] = useState<CreditPackage[] | null>(null);
  const [editing, setEditing] = useState<CreditPackage | "new" | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => apiRequest<CreditPackage[]>("/admin/credits/packages", {}, token).then(setRows).catch((reason) => setError(message(reason, "读取套餐失败"))), [token]);
  useEffect(() => { void load(); }, [load]);
  const remove = async (row: CreditPackage) => {
    if (!window.confirm(`确定删除积分套餐“${row.name}”吗？历史购买记录会保留套餐快照。`)) return;
    try { await apiRequest(`/admin/credits/packages/${row.id}`, { method: "DELETE" }, token); await load(); }
    catch (reason) { setError(message(reason, "删除套餐失败")); }
  };
  return <section className="section-card table-card credit-table-card">
    <header><div><span className="kicker">PACKAGE CATALOG</span><h2>套餐列表</h2><p>价格以人民币显示，数据在服务器中以分保存。</p></div><div className="record-header-actions"><span className="record-count">{rows?.length ?? 0} 条</span><button className="primary" onClick={() => setEditing("new")}>新增套餐</button></div></header>
    {error && <div className="form-error">{error}</div>}
    {!rows ? <div className="loading-card"><span className="spinner" />正在读取套餐…</div> : <div className="table-scroll"><table><thead><tr><th>套餐</th><th>基础积分</th><th>赠送积分</th><th>总积分</th><th>售价</th><th>状态</th><th>排序</th><th>操作</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong><small className="cell-note">{row.code}</small></td><td>{row.base_credits.toLocaleString()}</td><td>{row.bonus_credits.toLocaleString()}</td><td><strong>{row.total_credits.toLocaleString()}</strong></td><td>¥{(row.price_fen / 100).toFixed(2)}</td><td><span className={`status ${tone(row.status)}`}>{row.status}</span></td><td>{row.sort_order}</td><td><div className="table-actions"><button className="secondary" onClick={() => setEditing(row)}>编辑</button><button className="danger-button" onClick={() => void remove(row)}>删除</button></div></td></tr>) : <tr><td colSpan={8} className="empty-row">暂无积分套餐</td></tr>}</tbody></table></div>}
    {editing && <PackageModal token={token} item={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}
  </section>;
}

function PackageModal({ token, item, onClose, onSaved }: { token: string; item: CreditPackage | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ code: item?.code || "", name: item?.name || "", description: item?.description || "", base_credits: String(item?.base_credits ?? 500), bonus_credits: String(item?.bonus_credits ?? 0), price_yuan: item ? (item.price_fen / 100).toFixed(2) : "9.90", currency: item?.currency || "CNY", status: item?.status || "ACTIVE", sort_order: String(item?.sort_order ?? 10) });
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(""); try { const body = { ...form, base_credits: Number(form.base_credits), bonus_credits: Number(form.bonus_credits), price_fen: Math.round(Number(form.price_yuan) * 100), sort_order: Number(form.sort_order) }; await apiRequest(item ? `/admin/credits/packages/${item.id}` : "/admin/credits/packages", { method: item ? "PATCH" : "POST", body: JSON.stringify(body) }, token); await onSaved(); } catch (reason) { setError(message(reason, "保存套餐失败")); } finally { setSaving(false); } };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><header><div><span className="kicker">{item ? "EDIT PACKAGE" : "NEW PACKAGE"}</span><h2>{item ? "编辑积分套餐" : "新增积分套餐"}</h2></div><button type="button" onClick={onClose}>×</button></header><div className="two-columns"><label>套餐名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label><label>套餐 Code<input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toLowerCase() })} placeholder="starter-500" required /></label></div><label>套餐说明<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><div className="three-columns"><label>基础积分<input type="number" min="1" step="1" value={form.base_credits} onChange={(event) => setForm({ ...form, base_credits: event.target.value })} required /></label><label>赠送积分<input type="number" min="0" step="1" value={form.bonus_credits} onChange={(event) => setForm({ ...form, bonus_credits: event.target.value })} required /></label><label>售价（元）<input type="number" min="0.01" step="0.01" value={form.price_yuan} onChange={(event) => setForm({ ...form, price_yuan: event.target.value })} required /></label></div><div className="three-columns"><label>币种<input value={form.currency} maxLength={3} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} required /></label><label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label><label>排序值<input type="number" min="0" step="1" value={form.sort_order} onChange={(event) => setForm({ ...form, sort_order: event.target.value })} required /></label></div>{error && <div className="form-error">{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存套餐"}</button></footer></form></div>;
}

function PurchasesManager({ token }: { token: string }) {
  const [rows, setRows] = useState<CreditPurchase[] | null>(null); const [packages, setPackages] = useState<CreditPackage[]>([]); const [users, setUsers] = useState<UserOption[]>([]); const [editing, setEditing] = useState<CreditPurchase | "new" | null>(null); const [error, setError] = useState("");
  const load = useCallback(async () => { try { const [purchaseRows, packageRows, userRows] = await Promise.all([apiRequest<CreditPurchase[]>("/admin/credits/purchases?limit=200", {}, token), apiRequest<CreditPackage[]>("/admin/credits/packages", {}, token), apiRequest<UserOption[]>("/admin/users?limit=200", {}, token)]); setRows(purchaseRows); setPackages(packageRows); setUsers(userRows); } catch (reason) { setError(message(reason, "读取购买记录失败")); } }, [token]);
  useEffect(() => { void load(); }, [load]);
  const remove = async (row: CreditPurchase) => { if (!window.confirm(`确定删除购买记录 ${row.purchase_no} 吗？`)) return; try { await apiRequest(`/admin/credits/purchases/${row.id}`, { method: "DELETE" }, token); await load(); } catch (reason) { setError(message(reason, "删除购买记录失败")); } };
  return <section className="section-card table-card credit-table-card"><header><div><span className="kicker">PURCHASE LEDGER</span><h2>购买记录</h2><p>套餐名称、积分和售价均保存购买时快照。</p></div><div className="record-header-actions"><span className="record-count">{rows?.length ?? 0} 条</span><button className="primary" disabled={!users.length || !packages.length} onClick={() => setEditing("new")}>新增购买记录</button></div></header>{error && <div className="form-error">{error}</div>}{!rows ? <div className="loading-card"><span className="spinner" />正在读取购买记录…</div> : <div className="table-scroll"><table><thead><tr><th>购买单号</th><th>用户</th><th>套餐</th><th>到账积分</th><th>实付</th><th>状态</th><th>购买时间</th><th>操作</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={row.id}><td><code>{row.purchase_no}</code></td><td><strong>{row.user_name || "未命名"}</strong><small className="cell-note">{row.user_email || row.user_id}</small></td><td>{row.package_name_snapshot}<small className="cell-note">{row.package_code_snapshot}</small></td><td>{row.credits_granted.toLocaleString()}</td><td>¥{(row.paid_amount_fen / 100).toFixed(2)}</td><td><span className={`status ${tone(row.status)}`}>{row.status}</span></td><td>{formatDate(row.purchased_at)}</td><td><div className="table-actions"><button className="secondary" onClick={() => setEditing(row)}>编辑</button><button className="danger-button" onClick={() => void remove(row)}>删除</button></div></td></tr>) : <tr><td colSpan={8} className="empty-row">暂无套餐购买记录</td></tr>}</tbody></table></div>}{editing && <PurchaseModal token={token} item={editing === "new" ? null : editing} packages={packages} users={users} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}</section>;
}

function PurchaseModal({ token, item, packages, users, onClose, onSaved }: { token: string; item: CreditPurchase | null; packages: CreditPackage[]; users: UserOption[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const initialPackage = packages.find((row) => row.id === item?.package_id) || packages[0];
  const [form, setForm] = useState({ user_id: item?.user_id || users[0]?.id || "", package_id: initialPackage?.id || "", credits_granted: String(item?.credits_granted ?? initialPackage?.total_credits ?? 0), paid_yuan: item ? (item.paid_amount_fen / 100).toFixed(2) : initialPackage ? (initialPackage.price_fen / 100).toFixed(2) : "0.00", currency: item?.currency || initialPackage?.currency || "CNY", payment_order_id: item?.payment_order_id || "", status: item?.status || "CREATED", purchased_at: item?.purchased_at ? dateTimeLocal(item.purchased_at) : "", notes: item?.notes || "" });
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const choosePackage = (packageId: string) => { const selected = packages.find((row) => row.id === packageId); setForm({ ...form, package_id: packageId, credits_granted: String(selected?.total_credits ?? form.credits_granted), paid_yuan: selected ? (selected.price_fen / 100).toFixed(2) : form.paid_yuan, currency: selected?.currency || form.currency }); };
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(""); try { await apiRequest(item ? `/admin/credits/purchases/${item.id}` : "/admin/credits/purchases", { method: item ? "PATCH" : "POST", body: JSON.stringify({ ...form, credits_granted: Number(form.credits_granted), paid_amount_fen: Math.round(Number(form.paid_yuan) * 100), purchased_at: form.purchased_at ? asIso(form.purchased_at) : null }) }, token); await onSaved(); } catch (reason) { setError(message(reason, "保存购买记录失败")); } finally { setSaving(false); } };
  return <div className="modal-backdrop"><form className="modal model-modal" onSubmit={submit}><header><div><span className="kicker">{item ? "EDIT PURCHASE" : "NEW PURCHASE"}</span><h2>{item ? "编辑购买记录" : "新增购买记录"}</h2></div><button type="button" onClick={onClose}>×</button></header><div className="two-columns"><label>用户<select value={form.user_id} onChange={(event) => setForm({ ...form, user_id: event.target.value })} required>{users.map((user) => <option key={user.id} value={user.id}>{userLabel(user)}</option>)}</select></label><label>积分套餐<select value={form.package_id} onChange={(event) => choosePackage(event.target.value)} required>{packages.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.total_credits} 积分</option>)}</select></label></div><div className="three-columns"><label>到账积分<input type="number" min="1" step="1" value={form.credits_granted} onChange={(event) => setForm({ ...form, credits_granted: event.target.value })} required /></label><label>实付金额（元）<input type="number" min="0" step="0.01" value={form.paid_yuan} onChange={(event) => setForm({ ...form, paid_yuan: event.target.value })} required /></label><label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="CREATED">待支付</option><option value="PAID">已支付</option><option value="CANCELED">已取消</option><option value="REFUNDED">已退款</option></select></label></div><div className="two-columns"><label>购买时间<input type="datetime-local" value={form.purchased_at} onChange={(event) => setForm({ ...form, purchased_at: event.target.value })} /></label><label>支付订单 ID（可选）<input value={form.payment_order_id} onChange={(event) => setForm({ ...form, payment_order_id: event.target.value })} /></label></div><label>备注<textarea className="compact-textarea" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>{error && <div className="form-error">{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving || !form.user_id || !form.package_id}>{saving ? "保存中…" : "保存记录"}</button></footer></form></div>;
}

function ConsumptionsManager({ token }: { token: string }) {
  const [rows, setRows] = useState<CreditConsumption[] | null>(null); const [users, setUsers] = useState<UserOption[]>([]); const [editing, setEditing] = useState<CreditConsumption | "new" | null>(null); const [error, setError] = useState("");
  const load = useCallback(async () => { try { const [consumptionRows, userRows] = await Promise.all([apiRequest<CreditConsumption[]>("/admin/credits/consumptions?limit=200", {}, token), apiRequest<UserOption[]>("/admin/users?limit=200", {}, token)]); setRows(consumptionRows); setUsers(userRows); } catch (reason) { setError(message(reason, "读取消耗记录失败")); } }, [token]);
  useEffect(() => { void load(); }, [load]);
  const remove = async (row: CreditConsumption) => { if (!window.confirm(`确定删除消耗记录 ${row.consumption_no} 吗？`)) return; try { await apiRequest(`/admin/credits/consumptions/${row.id}`, { method: "DELETE" }, token); await load(); } catch (reason) { setError(message(reason, "删除消耗记录失败")); } };
  return <section className="section-card table-card credit-table-card"><header><div><span className="kicker">CREDIT USAGE</span><h2>消耗记录</h2><p>支持模型任务、API 测试、人工录入和积分调整。</p></div><div className="record-header-actions"><span className="record-count">{rows?.length ?? 0} 条</span><button className="primary" disabled={!users.length} onClick={() => setEditing("new")}>新增消耗记录</button></div></header>{error && <div className="form-error">{error}</div>}{!rows ? <div className="loading-card"><span className="spinner" />正在读取消耗记录…</div> : <div className="table-scroll"><table><thead><tr><th>记录号</th><th>用户</th><th>类型</th><th>模型/说明</th><th>消耗积分</th><th>状态</th><th>发生时间</th><th>操作</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={row.id}><td><code>{row.consumption_no}</code></td><td><strong>{row.user_name || "未命名"}</strong><small className="cell-note">{row.user_email || row.user_id}</small></td><td>{row.category}</td><td>{row.model_alias || row.description || "—"}<small className="cell-note">{row.model_code || row.task_id || ""}</small></td><td><strong className="credit-negative">-{row.credits_consumed.toLocaleString()}</strong></td><td><span className={`status ${tone(row.status)}`}>{row.status}</span></td><td>{formatDate(row.occurred_at)}</td><td><div className="table-actions"><button className="secondary" onClick={() => setEditing(row)}>编辑</button><button className="danger-button" onClick={() => void remove(row)}>删除</button></div></td></tr>) : <tr><td colSpan={8} className="empty-row">暂无积分消耗记录</td></tr>}</tbody></table></div>}{editing && <ConsumptionModal token={token} item={editing === "new" ? null : editing} users={users} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}</section>;
}

function ConsumptionModal({ token, item, users, onClose, onSaved }: { token: string; item: CreditConsumption | null; users: UserOption[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ user_id: item?.user_id || users[0]?.id || "", category: item?.category || "MODEL_TASK", credits_consumed: String(item?.credits_consumed ?? 1), status: item?.status || "CONFIRMED", occurred_at: dateTimeLocal(item?.occurred_at), task_id: item?.task_id || "", provider_model_id: item?.provider_model_id || "", description: item?.description || "", notes: item?.notes || "", metadata: JSON.stringify(item?.metadata_json || {}, null, 2) });
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(""); try { const body = { ...form, credits_consumed: Number(form.credits_consumed), occurred_at: asIso(form.occurred_at), metadata: JSON.parse(form.metadata) }; await apiRequest(item ? `/admin/credits/consumptions/${item.id}` : "/admin/credits/consumptions", { method: item ? "PATCH" : "POST", body: JSON.stringify(body) }, token); await onSaved(); } catch (reason) { setError(message(reason, "保存消耗记录失败")); } finally { setSaving(false); } };
  return <div className="modal-backdrop"><form className="modal model-modal" onSubmit={submit}><header><div><span className="kicker">{item ? "EDIT CONSUMPTION" : "NEW CONSUMPTION"}</span><h2>{item ? "编辑积分消耗" : "新增积分消耗"}</h2></div><button type="button" onClick={onClose}>×</button></header><div className="two-columns"><label>用户<select value={form.user_id} onChange={(event) => setForm({ ...form, user_id: event.target.value })} required>{users.map((user) => <option key={user.id} value={user.id}>{userLabel(user)}</option>)}</select></label><label>发生时间<input type="datetime-local" value={form.occurred_at} onChange={(event) => setForm({ ...form, occurred_at: event.target.value })} required /></label></div><div className="three-columns"><label>消耗类型<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}><option value="MODEL_TASK">模型任务</option><option value="API_TEST">API 测试</option><option value="MANUAL">人工录入</option><option value="ADJUSTMENT">积分调整</option></select></label><label>消耗积分<input type="number" min="0.000001" step="0.000001" value={form.credits_consumed} onChange={(event) => setForm({ ...form, credits_consumed: event.target.value })} required /></label><label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="PENDING">待确认</option><option value="CONFIRMED">已确认</option><option value="REVERSED">已冲正</option><option value="CANCELED">已取消</option></select></label></div><div className="two-columns"><label>任务 ID（可选）<input value={form.task_id} onChange={(event) => setForm({ ...form, task_id: event.target.value })} /></label><label>供应商模型 ID（可选）<input value={form.provider_model_id} onChange={(event) => setForm({ ...form, provider_model_id: event.target.value })} /></label></div><label>消耗说明<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} required /></label><label>备注<input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><label>扩展数据 JSON<textarea className="compact-textarea" value={form.metadata} onChange={(event) => setForm({ ...form, metadata: event.target.value })} spellCheck={false} /></label>{error && <div className="form-error">{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving || !form.user_id}>{saving ? "保存中…" : "保存记录"}</button></footer></form></div>;
}
