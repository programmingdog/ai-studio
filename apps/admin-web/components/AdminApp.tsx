"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/api";
import { DefaultModelConfigPanel, ProvidersPanel } from "@/components/ProvidersPanel";
import { ModelTestRecordsPanel } from "@/components/ModelTestRecordsPanel";
import { CreditsPanel } from "@/components/CreditsPanel";
import { WechatPaymentConfigPanel } from "@/components/WechatPaymentConfigPanel";
import { CatalogPanel } from "@/components/CatalogPanel";
import { UsersPanel } from "@/components/UsersPanel";
import { CreditPricingPanel } from "@/components/CreditPricingPanel";
import { MailConfigPanel } from "@/components/MailConfigPanel";
import { DistributionConfigPanel, DistributionRecordsPanel } from "@/components/DistributionPanel";
import { AuthMethodsConfigPanel } from "@/components/AuthMethodsConfigPanel";
import { SoftwareDownloadConfigPanel } from "@/components/SoftwareDownloadConfigPanel";
import { IpAccessRulesPanel } from "@/components/IpAccessRulesPanel";
import { ProductBrandConfigPanel } from "@/components/ProductBrandConfigPanel";
import { useProductBrand } from "@/components/ProductBrand";
import { DashboardOverview } from "@/components/DashboardOverview";
import { DesktopReleasePanel } from "@/components/DesktopReleasePanel";
import { ScriptAnalysisConfigPanel, ScriptAnalysisPricingPanel } from "@/components/ScriptAnalysisConfigPanel";
import { ClientRuntimeConfigPanel } from "@/components/ClientRuntimeConfigPanel";

type View = "overview" | "product-brand" | "auth-methods" | "client-distribution" | "model-routing" | "providers" | "script-analysis" | "configs" | "creative-presets" | "users" | "distribution-config" | "referral-rewards" | "commission-settlement" | "credit-pricing" | "credit-packages" | "orders" | "credit-consumptions" | "integrations" | "ip-access" | "tasks" | "model-tests" | "audit";
type NavigationItem = { id: View; label: string; eyebrow: string };
type NavigationGroup = { id: "product" | "ai" | "growth" | "commerce" | "operations"; label: string; eyebrow: string; mark: string; items: NavigationItem[] };
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

const primaryNavigation: NavigationItem[] = [
  { id: "overview", label: "运营概览", eyebrow: "OVERVIEW" },
];
const navigationGroups: NavigationGroup[] = [
  { id: "product", label: "产品与客户端", eyebrow: "PRODUCT & CLIENT", mark: "PC", items: [
    { id: "product-brand", label: "品牌与展示", eyebrow: "BRAND" },
    { id: "auth-methods", label: "注册与登录", eyebrow: "ACCESS" },
    { id: "client-distribution", label: "下载与版本", eyebrow: "DELIVERY" },
  ] },
  { id: "ai", label: "AI 与创作", eyebrow: "AI & CREATION", mark: "AI", items: [
    { id: "model-routing", label: "模型路由", eyebrow: "ROUTING" },
    { id: "providers", label: "供应商与模型", eyebrow: "GATEWAY" },
    { id: "script-analysis", label: "剧本提取", eyebrow: "SCRIPT" },
    { id: "configs", label: "提示词与工作流", eyebrow: "WORKFLOWS" },
    { id: "creative-presets", label: "创作预设", eyebrow: "PRESETS" },
  ] },
  { id: "growth", label: "用户与增长", eyebrow: "USERS & GROWTH", mark: "UG", items: [
    { id: "users", label: "用户管理", eyebrow: "USERS" },
    { id: "distribution-config", label: "分销规则", eyebrow: "DISTRIBUTION" },
    { id: "referral-rewards", label: "邀请与奖励", eyebrow: "INVITATIONS" },
    { id: "commission-settlement", label: "佣金结算", eyebrow: "SETTLEMENT" },
  ] },
  { id: "commerce", label: "交易与积分", eyebrow: "BILLING & CREDITS", mark: "BC", items: [
    { id: "credit-pricing", label: "积分定价", eyebrow: "PRICING" },
    { id: "credit-packages", label: "积分套餐", eyebrow: "PACKAGES" },
    { id: "orders", label: "交易订单", eyebrow: "ORDERS" },
    { id: "credit-consumptions", label: "积分流水", eyebrow: "LEDGER" },
  ] },
  { id: "operations", label: "系统与运维", eyebrow: "SYSTEM & OPS", mark: "SO", items: [
    { id: "integrations", label: "渠道集成", eyebrow: "INTEGRATIONS" },
    { id: "ip-access", label: "安全与访问", eyebrow: "SECURITY" },
    { id: "tasks", label: "任务监控", eyebrow: "TASKS" },
    { id: "model-tests", label: "模型诊断", eyebrow: "DIAGNOSTICS" },
    { id: "audit", label: "审计日志", eyebrow: "AUDIT" },
  ] },
];
const navigation = [...primaryNavigation, ...navigationGroups.flatMap((group) => group.items)];

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
  const [openGroups, setOpenGroups] = useState<Record<NavigationGroup["id"], boolean>>({ product: false, ai: false, growth: false, commerce: false, operations: false });
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
          {navigationGroups.map((group) => {
            const open = openGroups[group.id];
            const hasActive = group.items.some((item) => item.id === view);
            return <div key={group.id} className={`nav-section ${open ? "open" : ""} ${hasActive ? "has-active" : ""}`}>
              <button className="nav-parent" type="button" aria-expanded={open} onClick={() => setOpenGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}><span>{group.mark}</span><div>{group.label}<small>{group.eyebrow}</small></div><b>⌄</b></button>
              <div className="subnav">{group.items.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><i /> <div>{item.label}<small>{item.eyebrow}</small></div></button>)}</div>
            </div>;
          })}
        </nav>
      </aside>
      <main>
        <header className="topbar"><div><span>{active.eyebrow}</span><h1>{active.label}</h1></div><div className="admin-profile"><span>{admin.displayName.slice(0, 1).toUpperCase()}</span><div className="admin-identity"><strong>{admin.displayName}</strong><small>{admin.email}</small></div><div className="admin-profile-actions"><button type="button" onClick={() => setPasswordOpen(true)}>修改密码</button><button type="button" onClick={logout}>退出</button></div></div></header>
        <div className={`content ${view === "overview" ? "dashboard-content" : ""}`}>
          {view === "overview" && <DashboardOverview token={token} />}
          {view === "product-brand" && <ProductBrandConfigPanel token={token} />}
          {view === "auth-methods" && <AuthMethodsConfigPanel token={token} />}
          {view === "client-distribution" && <PageTabs label="客户端配置" description="集中维护客户端运行参数、下载入口与版本发布。" tabs={[
            { id: "client-runtime", label: "运行参数", content: <ClientRuntimeConfigPanel token={token} /> },
            { id: "software-downloads", label: "下载入口", content: <SoftwareDownloadConfigPanel token={token} /> },
            { id: "client-releases", label: "版本发布", content: <DesktopReleasePanel token={token} /> },
          ]} />}
          {view === "model-routing" && <DefaultModelConfigPanel token={token} />}
          {view === "providers" && <ProvidersPanel token={token} />}
          {view === "script-analysis" && <><ConfigScope title="剧本提取能力" description="服务端读取提示词并调用默认文本模型；客户端只负责提交剧本和接收结果。" badges={["服务端执行", "保存即生效", "依赖默认文本模型"]} /><ScriptAnalysisModelSummary token={token} onOpenRouting={() => setView("model-routing")} /><ScriptAnalysisConfigPanel token={token} /></>}
          {view === "configs" && <ConfigsPanel token={token} />}
          {view === "creative-presets" && <PageTabs label="创作预设" description="统一维护客户端可选择的创作目录。" tabs={[
            { id: "visual-styles", label: "画风", content: <CatalogPanel token={token} kind="visual-styles" /> },
            { id: "creative-types", label: "创作类型", content: <CatalogPanel token={token} kind="creative-types" /> },
          ]} />}
          {view === "distribution-config" && <DistributionConfigPanel token={token} />}
          {view === "referral-rewards" && <DistributionRecordsPanel token={token} kind="rewards" />}
          {view === "commission-settlement" && <PageTabs label="佣金结算" description="按分润、申请和实际打款顺序处理完整结算流程。" tabs={[
            { id: "commissions", label: "分润记录", content: <DistributionRecordsPanel token={token} kind="commissions" /> },
            { id: "withdrawals", label: "提现申请", content: <DistributionRecordsPanel token={token} kind="withdrawals" /> },
            { id: "payouts", label: "打款记录", content: <DistributionRecordsPanel token={token} kind="payouts" /> },
          ]} />}
          {view === "users" && <UsersPanel token={token} />}
          {view === "credit-pricing" && <PageTabs label="积分定价" description="集中维护积分换算、自动定价和独立功能的固定积分。" tabs={[
            { id: "base-pricing", label: "基础换算", content: <CreditPricingPanel token={token} /> },
            { id: "feature-pricing", label: "功能定价", content: <ScriptAnalysisPricingPanel token={token} /> },
          ]} />}
          {view === "credit-packages" && <CreditsPanel token={token} section="packages" />}
          {view === "orders" && <PageTabs label="交易订单" description="统一查看积分购买业务单和支付渠道订单。" tabs={[
            { id: "credit-purchases", label: "积分购买", content: <CreditsPanel token={token} section="purchases" /> },
            { id: "payments", label: "支付订单", content: <DataPanel token={token} path="/admin/payments" empty="还没有微信支付订单" columns={["out_trade_no", "description", "amount_fen", "status", "paid_at", "created_at"]} /> },
          ]} />}
          {view === "credit-consumptions" && <CreditsPanel token={token} section="consumptions" />}
          {view === "integrations" && <PageTabs label="外部渠道集成" description="敏感凭据集中维护；注册、登录和支付页面只引用这里的连接状态。" tabs={[
            { id: "mail-config", label: "邮件服务", content: <MailConfigPanel token={token} /> },
            { id: "wechat-config", label: "微信平台", content: <WechatPaymentConfigPanel token={token} /> },
          ]} />}
          {view === "ip-access" && <IpAccessRulesPanel token={token} />}
          {view === "tasks" && <DataPanel token={token} path="/admin/tasks" empty="还没有任务记录" columns={["task_type", "logical_model_code", "status", "progress", "estimated_credits", "created_at"]} />}
          {view === "model-tests" && <ModelTestRecordsPanel token={token} />}
          {view === "audit" && <DataPanel token={token} path="/admin/audit-logs" empty="还没有管理操作记录" columns={["admin_name", "action", "entity_type", "entity_id", "created_at"]} />}
        </div>
      </main>
      {passwordOpen && <ChangePasswordModal token={token} onClose={() => setPasswordOpen(false)} />}
    </div>
  );
}

function PageTabs({ label, description, tabs }: { label: string; description: string; tabs: { id: string; label: string; content: ReactNode }[] }) {
  const [activeId, setActiveId] = useState(tabs[0]?.id || "");
  const active = tabs.find((tab) => tab.id === activeId) || tabs[0];
  if (!active) return null;
  return <div className="workspace-tabs">
    <section className="workspace-tabs-header">
      <div><span className="kicker">WORKSPACE</span><h2>{label}</h2><p>{description}</p></div>
      <div className="workspace-tab-list" role="tablist" aria-label={label}>{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={active.id === tab.id} className={active.id === tab.id ? "active" : ""} onClick={() => setActiveId(tab.id)}>{tab.label}</button>)}</div>
    </section>
    <div className="workspace-tab-content" role="tabpanel" key={active.id}>{active.content}</div>
  </div>;
}

function ConfigScope({ title, description, badges }: { title: string; description: string; badges: string[] }) {
  return <section className="config-scope"><div><span className="kicker">CONFIGURATION SCOPE</span><h2>{title}</h2><p>{description}</p></div><div>{badges.map((badge) => <span key={badge}>{badge}</span>)}</div></section>;
}

function ScriptAnalysisModelSummary({ token, onOpenRouting }: { token: string; onOpenRouting: () => void }) {
  const [model, setModel] = useState("正在读取…");
  useEffect(() => {
    let active = true;
    apiRequest<{ text_model_id: string | null; candidates: { id: string; provider_name: string; model_alias: string; display_name: string }[] }>("/admin/providers/default-model-config", {}, token)
      .then((result) => {
        if (!active) return;
        const selected = result.candidates.find((candidate) => candidate.id === result.text_model_id);
        setModel(selected ? `${selected.provider_name} · ${selected.model_alias} · ${selected.display_name}` : "尚未配置默认文本模型");
      })
      .catch(() => { if (active) setModel("默认文本模型读取失败"); });
    return () => { active = false; };
  }, [token]);
  return <section className="dependency-card"><div><span>执行依赖</span><strong>{model}</strong><small>剧本提取不会在这里复制模型设置，模型路由保持唯一配置入口。</small></div><button type="button" className="secondary" onClick={onOpenRouting}>前往模型路由</button></section>;
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
  return <><ConfigScope title="提示词与工作流" description="按业务能力维护可版本化配置；客户端下发只是生效范围，不再作为菜单分类。" badges={["版本化", "发布后生效", "stable 渠道"]} /><div className="split-view config-split"><section className="list-card"><header><div><span className="kicker">VERSIONED AI CONFIG</span><h2>配置目录</h2><p>提示词、生成参数与工作流按类型归档。</p></div><button className="secondary" onClick={() => setShowCreate(true)}>新建配置</button></header>{grouped.map(([category, rows]) => <div className="config-group" key={category}><strong>{category}</strong>{rows.map((item) => <button className={selected?.id === item.id ? "selected" : ""} key={item.id} onClick={() => choose(item)}><div><b>{item.name}</b><small>{item.config_key}</small></div><span className={`status ${statusTone(item.version_status)}`}>v{item.version || 0} · {item.version_status || "EMPTY"}</span></button>)}</div>)}</section><section className="editor-card">{selected ? <><header><div><span className="kicker">{selected.category}</span><h2>{selected.name}</h2><p>{selected.description}</p></div><span className={`status ${statusTone(selected.version_status)}`}>{selected.version_status}</span></header><label>配置 JSON<textarea value={editor} onChange={(event) => setEditor(event.target.value)} spellCheck={false} /></label>{error && <div className="form-error">{error}</div>}{message && <div className="form-success">{message}</div>}<footer><button className="secondary" onClick={() => setEditor(JSON.stringify(selected.value_json ?? {}, null, 2))}>撤销编辑</button><button className="secondary" onClick={saveVersion}>保存为新版本</button><button className="primary" onClick={publish} disabled={!selected.version_id}>发布当前版本</button></footer></> : <div className="empty-editor"><strong>选择一个配置</strong><p>查看提示词或自动化流程，并以新版本方式修改。</p></div>}</section>{showCreate && <CreateConfigModal token={token} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load(); }} />}</div></>;
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
