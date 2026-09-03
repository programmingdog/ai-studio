"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/api";
import { ProvidersPanel } from "@/components/ProvidersPanel";
import { ModelTestRecordsPanel } from "@/components/ModelTestRecordsPanel";
import { CreditsPanel } from "@/components/CreditsPanel";
import { WechatPaymentConfigPanel } from "@/components/WechatPaymentConfigPanel";
import { CatalogPanel } from "@/components/CatalogPanel";
import { UsersPanel } from "@/components/UsersPanel";
import { CreditPricingPanel } from "@/components/CreditPricingPanel";
import { CreditMultipliersPanel } from "@/components/CreditMultipliersPanel";
import { MailConfigPanel } from "@/components/MailConfigPanel";
import { DistributionConfigPanel, DistributionRecordsPanel } from "@/components/DistributionPanel";
import { AuthMethodsConfigPanel } from "@/components/AuthMethodsConfigPanel";
import { SoftwareDownloadConfigPanel } from "@/components/SoftwareDownloadConfigPanel";
import { IpAccessRulesPanel } from "@/components/IpAccessRulesPanel";
import { ProductBrandConfigPanel } from "@/components/ProductBrandConfigPanel";
import { useProductBrand } from "@/components/ProductBrand";
import { DashboardOverview } from "@/components/DashboardOverview";

type View = "overview" | "configs" | "mail-config" | "software-downloads" | "distribution-config" | "commissions" | "withdrawals" | "payouts" | "referral-rewards" | "visual-styles" | "creative-types" | "providers" | "model-tests" | "users" | "tasks" | "credit-packages" | "credit-purchases" | "credit-consumptions" | "payments" | "audit";
type AdminPrincipal = { sub: string; email: string; displayName: string; roles: string[]; permissions: string[]; mustChangePassword: boolean; mfaRequired: boolean };
type ConfigItem = {
  id: string; config_key: string; category: string; name: string; description: string; status: string;
  version_id: string | null; version: number | null; version_status: string | null; value_json: unknown; checksum: string | null;
};
type GenericRow = Record<string, unknown>;

function normalizeAdminPrincipal(value: unknown): AdminPrincipal {
  if (!value || typeof value !== "object") throw new Error("管理员资料格式无效，请重新登录");
  const source = value as Record<string, unknown>;
  const email = typeof source.email === "string" ? source.email.trim() : "";
  const sub = typeof source.sub === "string" ? source.sub : "";
  if (!email || !sub) throw new Error("管理员资料不完整，请重新登录");
  const rawDisplayName = typeof source.displayName === "string" ? source.displayName.trim() : "";
  return {
    sub,
    email,
    displayName: rawDisplayName || email.split("@")[0] || "管理员",
    roles: Array.isArray(source.roles) ? source.roles.filter((item): item is string => typeof item === "string") : [],
    permissions: Array.isArray(source.permissions) ? source.permissions.filter((item): item is string => typeof item === "string") : [],
    mustChangePassword: source.mustChangePassword === true,
    mfaRequired: source.mfaRequired === true,
  };
}

const primaryNavigation: { id: View; label: string; eyebrow: string }[] = [
  { id: "overview", label: "运营概览", eyebrow: "OVERVIEW" },
];
const settingsNavigation: { id: View; label: string; eyebrow: string }[] = [
  { id: "configs", label: "配置中心", eyebrow: "CONFIG" },
  { id: "mail-config", label: "邮箱配置", eyebrow: "EMAIL" },
  { id: "software-downloads", label: "软件下载", eyebrow: "DOWNLOADS" },
  { id: "distribution-config", label: "分销配置", eyebrow: "DISTRIBUTION" },
  { id: "visual-styles", label: "画风设定", eyebrow: "STYLES" },
  { id: "creative-types", label: "创作类型", eyebrow: "CREATIVE" },
  { id: "providers", label: "AI 供应商", eyebrow: "GATEWAY" },
];
const userNavigation: { id: View; label: string; eyebrow: string }[] = [
  { id: "users", label: "用户管理", eyebrow: "USERS" },
  { id: "referral-rewards", label: "邀请奖励", eyebrow: "INVITATIONS" },
  { id: "commissions", label: "分润记录", eyebrow: "COMMISSIONS" },
  { id: "withdrawals", label: "提现申请", eyebrow: "WITHDRAWALS" },
  { id: "payouts", label: "打款记录", eyebrow: "PAYOUTS" },
  { id: "payments", label: "微信支付", eyebrow: "PAYMENTS" },
];
const creditNavigation: { id: View; label: string; eyebrow: string }[] = [
  { id: "credit-packages", label: "积分套餐", eyebrow: "PACKAGES" },
  { id: "credit-purchases", label: "购买记录", eyebrow: "PURCHASES" },
  { id: "credit-consumptions", label: "消耗记录", eyebrow: "CONSUMPTION" },
];
const recordNavigation: { id: View; label: string; eyebrow: string }[] = [
  { id: "audit", label: "审计日志", eyebrow: "AUDIT" },
  { id: "tasks", label: "任务元数据", eyebrow: "TASKS" },
  { id: "model-tests", label: "测试记录", eyebrow: "MODEL TESTS" },
];
const navigation = [...primaryNavigation, ...settingsNavigation, ...userNavigation, ...creditNavigation, ...recordNavigation];

function formatDate(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function statusTone(status: unknown) {
  const value = String(status || "").toUpperCase();
  if (["ACTIVE", "PAID", "PUBLISHED", "COMPLETED", "SUCCEEDED"].includes(value)) return "good";
  if (["FAILED", "DISABLED", "REJECTED", "CANCELED"].includes(value)) return "bad";
  return "warn";
}

export function AdminApp() {
  const productBrand = useProductBrand();
  const [token, setToken] = useState<string | null>(null);
  const [admin, setAdmin] = useState<AdminPrincipal | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>("overview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const logout = useCallback(() => {
    localStorage.removeItem("aivs_admin_token");
    setToken(null);
    setAdmin(null);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("aivs_admin_token");
    if (!saved) { setChecking(false); return; }
    apiRequest<unknown>("/admin/auth/me", {}, saved)
      .then((profile) => { setToken(saved); setAdmin(normalizeAdminPrincipal(profile)); })
      .catch(logout)
      .finally(() => setChecking(false));
  }, [logout]);
  useEffect(() => { document.title = `${productBrand.chinese_name}管理后台`; }, [productBrand.chinese_name]);

  if (checking) return <div className="boot-screen"><span className="spinner" />正在验证管理会话…</div>;
  if (!token || !admin) return <LoginScreen onLogin={(nextToken, profile) => { setToken(nextToken); setAdmin(profile); }} />;
  if (admin.mustChangePassword) return <ChangePasswordScreen token={token} email={admin.email} onChanged={logout} />;

  const active = navigation.find((item) => item.id === view) || navigation[0]!;
  return (
    <div className="admin-layout">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">{productBrand.chinese_name.slice(0, 1)}</span><div><strong>{productBrand.chinese_name}</strong><small>{productBrand.english_name}</small></div></div>
        <nav>
          {primaryNavigation.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><span>{item.eyebrow.slice(0, 2)}</span><div>{item.label}<small>{item.eyebrow}</small></div></button>)}
          <div className={`nav-section ${settingsOpen ? "open" : ""} ${settingsNavigation.some((item) => item.id === view) ? "has-active" : ""}`}>
            <button className="nav-parent" type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><span>SE</span><div>设定<small>SETTINGS</small></div><b>⌄</b></button>
            <div className="subnav">{settingsNavigation.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><i /> <div>{item.label}<small>{item.eyebrow}</small></div></button>)}</div>
          </div>
          <div className={`nav-section ${usersOpen ? "open" : ""} ${userNavigation.some((item) => item.id === view) ? "has-active" : ""}`}>
            <button className="nav-parent" type="button" aria-expanded={usersOpen} onClick={() => setUsersOpen((open) => !open)}><span>US</span><div>用户<small>USERS</small></div><b>⌄</b></button>
            <div className="subnav">{userNavigation.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><i /> <div>{item.label}<small>{item.eyebrow}</small></div></button>)}</div>
          </div>
          <div className={`nav-section ${creditsOpen ? "open" : ""} ${view.startsWith("credit-") ? "has-active" : ""}`}>
            <button className="nav-parent" type="button" aria-expanded={creditsOpen} onClick={() => setCreditsOpen((open) => !open)}><span>CR</span><div>积分<small>CREDITS</small></div><b>⌄</b></button>
            <div className="subnav">{creditNavigation.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><i /> <div>{item.label}<small>{item.eyebrow}</small></div></button>)}</div>
          </div>
          <div className={`nav-section ${recordsOpen ? "open" : ""} ${recordNavigation.some((item) => item.id === view) ? "has-active" : ""}`}>
            <button className="nav-parent" type="button" aria-expanded={recordsOpen} onClick={() => setRecordsOpen((open) => !open)}><span>RE</span><div>记录<small>RECORDS</small></div><b>⌄</b></button>
            <div className="subnav">{recordNavigation.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><i /> <div>{item.label}<small>{item.eyebrow}</small></div></button>)}</div>
          </div>
        </nav>
      </aside>
      <main>
        <header className="topbar"><div><span>{active.eyebrow}</span><h1>{active.label}</h1></div><div className="admin-profile"><span>{admin.displayName.slice(0, 1).toUpperCase()}</span><div className="admin-identity"><strong>{admin.displayName}</strong><small>{admin.email}</small></div><div className="admin-profile-actions"><button type="button" onClick={() => setPasswordOpen(true)}>修改密码</button><button type="button" onClick={logout}>退出</button></div></div></header>
        <div className={`content ${view === "overview" ? "dashboard-content" : ""}`}>
          {view === "overview" && <DashboardOverview token={token} />}
          {view === "configs" && <><ProductBrandConfigPanel token={token} /><IpAccessRulesPanel token={token} /><AuthMethodsConfigPanel token={token} /><CreditMultipliersPanel token={token} /><CreditPricingPanel token={token} /><ConfigsPanel token={token} /></>}
          {view === "mail-config" && <MailConfigPanel token={token} />}
          {view === "software-downloads" && <SoftwareDownloadConfigPanel token={token} />}
          {view === "distribution-config" && <DistributionConfigPanel token={token} />}
          {(view === "commissions" || view === "withdrawals" || view === "payouts" || view === "referral-rewards") && <DistributionRecordsPanel key={view} token={token} kind={view === "referral-rewards" ? "rewards" : view} />}
          {view === "visual-styles" && <CatalogPanel token={token} kind="visual-styles" />}
          {view === "creative-types" && <CatalogPanel token={token} kind="creative-types" />}
          {view === "providers" && <ProvidersPanel token={token} />}
          {view === "model-tests" && <ModelTestRecordsPanel token={token} />}
          {view === "users" && <UsersPanel token={token} />}
          {view === "tasks" && <DataPanel token={token} path="/admin/tasks" empty="还没有任务记录" columns={["task_type", "logical_model_code", "status", "progress", "estimated_credits", "created_at"]} />}
          {view === "credit-packages" && <CreditsPanel token={token} section="packages" />}
          {view === "credit-purchases" && <CreditsPanel token={token} section="purchases" />}
          {view === "credit-consumptions" && <CreditsPanel token={token} section="consumptions" />}
          {view === "payments" && <DataPanel token={token} path="/admin/payments" empty="还没有微信支付订单" columns={["out_trade_no", "description", "amount_fen", "status", "paid_at", "created_at"]} />}
          {view === "audit" && <DataPanel token={token} path="/admin/audit-logs" empty="还没有管理操作记录" columns={["admin_name", "action", "entity_type", "entity_id", "created_at"]} />}
        </div>
      </main>
      {passwordOpen && <ChangePasswordModal token={token} onClose={() => setPasswordOpen(false)} />}
    </div>
  );
}

function ChangePasswordModal({ token, onClose }: { token: string; onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setMessage("");
    if (newPassword !== confirmation) { setError("两次输入的新密码不一致"); return; }
    setLoading(true);
    try {
      await apiRequest("/admin/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }, token);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setMessage("密码修改成功，下次登录请使用新密码。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "密码修改失败"); }
    finally { setLoading(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!loading && event.target === event.currentTarget) onClose(); }}><form className="modal password-change-modal" role="dialog" aria-modal="true" aria-labelledby="password-change-title" onSubmit={submit} onKeyDown={(event) => { if (!loading && event.key === "Escape") onClose(); }}><header><div><span className="kicker">ACCOUNT SECURITY</span><h2 id="password-change-title">修改登录密码</h2><p>验证当前密码后设置新密码，新密码至少 12 个字符。</p></div><button type="button" aria-label="关闭修改密码窗口" disabled={loading} onClick={onClose}>×</button></header><label>当前密码<input type="password" autoComplete="current-password" autoFocus value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label>新密码<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 12 个字符" required /></label><label>确认新密码<input type="password" autoComplete="new-password" minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>{error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}<footer><button type="button" className="secondary" disabled={loading} onClick={onClose}>{message ? "完成" : "取消"}</button><button className="primary" disabled={loading}>{loading ? "正在修改…" : "确认修改"}</button></footer></form></div>;
}

function ChangePasswordScreen({ token, email, onChanged }: { token: string; email: string; onChanged: () => void }) {
  const productBrand = useProductBrand();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    if (newPassword !== confirmation) { setError("两次输入的新密码不一致"); return; }
    setLoading(true);
    try {
      await apiRequest("/admin/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }, token);
      onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "修改失败"); }
    finally { setLoading(false); }
  };
  return <div className="login-page"><section className="login-hero"><div className="brand"><span className="brand-mark">{productBrand.chinese_name.slice(0, 1)}</span><div><strong>{productBrand.chinese_name}</strong><small>{productBrand.english_name}</small></div></div><div><span className="kicker">安心启程</span><h1>守护每份灵感，<br/>也守护<em>每次成长</em></h1><p>换一个更安心的密码，然后继续把脑海里的好故事，变成观众眼前的好作品。</p></div><footer><i />创作不停，热爱不息</footer></section><section className="login-panel"><form onSubmit={submit}><span className="kicker">PASSWORD ROTATION</span><h2>修改临时密码</h2><p>新密码至少 12 个字符，建议使用密码管理器生成。</p><label>当前临时密码<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label>新密码<input type="password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label><label>确认新密码<input type="password" minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>{error && <div className="form-error">{error}</div>}<button className="primary" disabled={loading}>{loading ? "正在修改…" : "修改并重新登录"}</button></form></section></div>;
}

function LoginScreen({ onLogin }: { onLogin: (token: string, admin: AdminPrincipal) => void }) {
  const productBrand = useProductBrand();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const result = await apiRequest<{ access_token: string; admin: AdminPrincipal }>("/admin/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      localStorage.setItem("aivs_admin_token", result.access_token);
      onLogin(result.access_token, normalizeAdminPrincipal(result.admin));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); }
    finally { setLoading(false); }
  };
  return <div className="login-page"><section className="login-hero"><div className="brand"><span className="brand-mark">{productBrand.chinese_name.slice(0, 1)}</span><div><strong>{productBrand.chinese_name}</strong><small>{productBrand.english_name}</small></div></div><div><span className="kicker">为好创意加速</span><h1>让每一个灵感，<br/>都值得被<em>看见</em></h1><p>从一个想法到一支好视频，让创作更简单，让表达更有力量，让好内容更快抵达观众。</p></div><footer><i />今天的灵感，就是明天的作品</footer></section><section className="login-panel"><form onSubmit={submit}><span className="kicker">ADMIN ACCESS</span><h2>登录管理后台</h2><p>使用管理员账号进入运营控制中心。</p><label>管理员邮箱<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" required /></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" required /></label>{error && <div className="form-error">{error}</div>}<button className="primary" disabled={loading}>{loading ? "正在登录…" : "安全登录"}</button><small>管理员操作会写入不可变审计日志。</small></form></section></div>;
}

function ConfigsPanel({ token }: { token: string }) {
  const [items, setItems] = useState<ConfigItem[]>([]);
  const [selected, setSelected] = useState<ConfigItem | null>(null);
  const [editor, setEditor] = useState("{}");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const load = useCallback(() => apiRequest<ConfigItem[]>("/admin/configs", {}, token).then((rows) => { setItems(rows); if (selected) setSelected(rows.find((row) => row.id === selected.id) || null); }), [token, selected]);
  useEffect(() => { void load(); }, [token]);
  const grouped = useMemo(() => Object.entries(items.reduce<Record<string, ConfigItem[]>>((result, item) => { (result[item.category] ||= []).push(item); return result; }, {})), [items]);
  const choose = (item: ConfigItem) => { setSelected(item); setEditor(JSON.stringify(item.value_json ?? {}, null, 2)); setMessage(""); setError(""); };
  const saveVersion = async () => {
    if (!selected) return;
    try { const value = JSON.parse(editor); await apiRequest(`/admin/configs/${selected.id}/versions`, { method: "POST", body: JSON.stringify({ value, change_note: "管理后台编辑" }) }, token); setMessage("已创建草稿版本"); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
  };
  const publish = async () => {
    if (!selected?.version_id) return;
    try { await apiRequest(`/admin/configs/${selected.id}/versions/${selected.version_id}/publish`, { method: "POST", body: JSON.stringify({ channel: "stable", rollout_percent: 100 }) }, token); setMessage("已发布到 stable 渠道"); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "发布失败"); }
  };
  return <><WechatPaymentConfigPanel token={token} /><div className="split-view config-split"><section className="list-card"><header><div><span className="kicker">VERSIONED DEFAULTS</span><h2>客户端默认配置</h2></div><button className="secondary" onClick={() => setShowCreate(true)}>新建配置</button></header>{grouped.map(([category, rows]) => <div className="config-group" key={category}><strong>{category}</strong>{rows.map((item) => <button className={selected?.id === item.id ? "selected" : ""} key={item.id} onClick={() => choose(item)}><div><b>{item.name}</b><small>{item.config_key}</small></div><span className={`status ${statusTone(item.version_status)}`}>v{item.version || 0} · {item.version_status || "EMPTY"}</span></button>)}</div>)}</section><section className="editor-card">{selected ? <><header><div><span className="kicker">{selected.category}</span><h2>{selected.name}</h2><p>{selected.description}</p></div><span className={`status ${statusTone(selected.version_status)}`}>{selected.version_status}</span></header><label>配置 JSON<textarea value={editor} onChange={(event) => setEditor(event.target.value)} spellCheck={false} /></label>{error && <div className="form-error">{error}</div>}{message && <div className="form-success">{message}</div>}<footer><button className="secondary" onClick={() => setEditor(JSON.stringify(selected.value_json ?? {}, null, 2))}>撤销编辑</button><button className="secondary" onClick={saveVersion}>保存为新版本</button><button className="primary" onClick={publish} disabled={!selected.version_id}>发布当前版本</button></footer></> : <div className="empty-editor"><strong>选择一个配置</strong><p>查看提示词或自动化流程，并以新版本方式修改。</p></div>}</section>{showCreate && <CreateConfigModal token={token} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load(); }} />}</div></>;
}

function CreateConfigModal({ token, onClose, onCreated }: { token: string; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ config_key: "", category: "PROMPT", name: "", description: "", value: "{}" });
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await apiRequest("/admin/configs", { method: "POST", body: JSON.stringify({ ...form, value: JSON.parse(form.value) }) }, token); onCreated(); } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); } };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><header><div><span className="kicker">NEW CONFIG</span><h2>新建版本化配置</h2></div><button type="button" onClick={onClose}>×</button></header><div className="two-columns"><label>配置键<input value={form.config_key} onChange={(event) => setForm({ ...form, config_key: event.target.value })} placeholder="prompt.storyboard.default" required /></label><label>分类<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}><option>PROMPT</option><option>GENERATION</option><option>PIPELINE</option></select></label></div><label>名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label><label>说明<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><label>初始 JSON<textarea value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} /></label>{error && <div className="form-error">{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary">创建草稿</button></footer></form></div>;
}

function DataPanel({ token, path, empty, columns }: { token: string; path: string; empty: string; columns: string[] }) {
  const [rows, setRows] = useState<GenericRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { apiRequest<GenericRow[]>(path, {}, token).then(setRows).catch((reason) => setError(String(reason))); }, [path, token]);
  if (error) return <ErrorCard message={error} />;
  if (!rows) return <LoadingCard />;
  return <section className="section-card table-card"><header><div><span className="kicker">LATEST RECORDS</span><h2>最近记录</h2><p>仅展示必要业务元数据，不展示任务提示词或媒体结果。</p></div><span className="record-count">{rows.length} 条</span></header>{rows.length ? <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id || index)}>{columns.map((column) => <td key={column}>{column.includes("status") ? <span className={`status ${statusTone(row[column])}`}>{String(row[column] ?? "—")}</span> : column.endsWith("_at") ? formatDate(row[column]) : column === "amount_fen" ? `¥${(Number(row[column] || 0) / 100).toFixed(2)}` : String(row[column] ?? "—")}</td>)}</tr>)}</tbody></table></div> : <div className="empty-row">{empty}</div>}</section>;
}

function LoadingCard() { return <div className="loading-card"><span className="spinner" />正在读取平台数据…</div>; }
function ErrorCard({ message }: { message: string }) { return <div className="form-error">{message}</div>; }
