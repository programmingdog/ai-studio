"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type Artifact = { id?: string; target: "windows" | "darwin"; arch: "x86_64" | "aarch64"; url: string; signature: string };
type Release = {
  id: string;
  version: string;
  channel: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  notes: string;
  min_supported_version: string;
  rollout_percent: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  artifacts: Artifact[];
};

const artifactOptions: Array<{ target: Artifact["target"]; arch: Artifact["arch"]; label: string; hint: string }> = [
  { target: "windows", arch: "x86_64", label: "Windows x64", hint: "填写 NSIS 的 .nsis.zip 更新包，不是安装用的 .exe" },
  { target: "darwin", arch: "x86_64", label: "macOS Intel", hint: "填写 .app.tar.gz 更新包，不是分发用的 .dmg" },
  { target: "darwin", arch: "aarch64", label: "macOS Apple Silicon", hint: "填写 arm64 的 .app.tar.gz 更新包" },
];

type ReleaseForm = Omit<Release, "id" | "status" | "created_at" | "updated_at" | "published_at">;
const emptyForm = (): ReleaseForm => ({ version: "", channel: "stable", notes: "", min_supported_version: "0.0.0", rollout_percent: 100, artifacts: [] });

function time(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function statusLabel(status: Release["status"]) {
  return status === "DRAFT" ? "草稿" : status === "PUBLISHED" ? "已发布" : "已归档";
}

export function DesktopReleasePanel({ token }: { token: string }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [editing, setEditing] = useState<Release | "new" | null>(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { setReleases(await apiRequest<Release[]>("/admin/desktop-releases", {}, token)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "读取版本列表失败"); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  async function action(release: Release, operation: "publish" | "archive" | "delete") {
    const messages = { publish: "确认发布此版本？发布后版本号、更新包与签名将不可修改。", archive: "确认归档此版本？客户端将不再收到该版本。", delete: "确认删除这个草稿？" };
    if (!window.confirm(messages[operation])) return;
    setBusyId(release.id); setError(""); setMessage("");
    try {
      await apiRequest(`/admin/desktop-releases/${release.id}${operation === "delete" ? "" : `/${operation}`}`, { method: operation === "delete" ? "DELETE" : "POST" }, token);
      setMessage(operation === "publish" ? `v${release.version} 已发布。` : operation === "archive" ? `v${release.version} 已归档。` : "草稿已删除。");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusyId(""); }
  }

  async function changeRollout(release: Release) {
    const value = window.prompt("输入新的灰度比例（1-100）", String(release.rollout_percent));
    if (value === null) return;
    const rollout = Number(value);
    if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) { setError("灰度比例必须是 1 到 100 的整数"); return; }
    setBusyId(release.id); setError(""); setMessage("");
    try {
      await apiRequest(`/admin/desktop-releases/${release.id}/rollout`, { method: "PATCH", body: JSON.stringify({ rollout_percent: rollout }) }, token);
      setMessage(`v${release.version} 的灰度比例已调整为 ${rollout}%。`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "调整灰度失败"); }
    finally { setBusyId(""); }
  }

  return <>
    <section className="section-card desktop-release-card">
      <header><div><span className="kicker">SIGNED DESKTOP UPDATES</span><h2>客户端版本管理</h2><p>管理签名更新包、灰度比例和强制升级门槛。发布后的版本不可编辑，避免线上清单被静默替换。</p></div><button className="primary" onClick={() => setEditing("new")}>新建版本</button></header>
      <div className="release-practices"><span>① CI 构建并签名</span><span>② 上传更新包与 .sig</span><span>③ 后台保存为草稿</span><span>④ 小范围验证后发布</span></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {message && <div className="form-success" role="status">{message}</div>}
      {!releases ? <div className="loading-card"><span className="spinner" />正在读取客户端版本…</div> : releases.length === 0 ? <div className="empty-row">还没有客户端版本。请先由构建机生成签名更新包。</div> : <div className="release-list">
        {releases.map((release) => <article key={release.id}>
          <div className="release-version"><strong>v{release.version}</strong><span className={`status ${release.status === "PUBLISHED" ? "good" : release.status === "ARCHIVED" ? "bad" : "warn"}`}>{statusLabel(release.status)}</span><small>{release.channel}</small></div>
          <div className="release-detail"><p>{release.notes || "未填写更新说明"}</p><small>更新包：{release.artifacts.map((item) => artifactOptions.find((option) => option.target === item.target && option.arch === item.arch)?.label || `${item.target}/${item.arch}`).join("、") || "尚未配置"}</small><small>灰度 {release.rollout_percent}% · 最低可运行 v{release.min_supported_version} · 发布于 {time(release.published_at)}</small></div>
          <div className="release-actions">
            {release.status === "DRAFT" && <><button className="secondary" disabled={busyId === release.id} onClick={() => setEditing(release)}>编辑</button><button className="primary" disabled={busyId === release.id || !release.artifacts.length} onClick={() => void action(release, "publish")}>发布</button><button className="danger-button" disabled={busyId === release.id} onClick={() => void action(release, "delete")}>删除</button></>}
            {release.status === "PUBLISHED" && <><button className="secondary" disabled={busyId === release.id} onClick={() => void changeRollout(release)}>调整灰度</button><button className="secondary" disabled={busyId === release.id} onClick={() => void action(release, "archive")}>停止分发</button></>}
          </div>
        </article>)}
      </div>}
    </section>
    {editing && <ReleaseEditor token={token} release={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={async (release) => { setEditing(null); setMessage(release.status === "DRAFT" ? `v${release.version} 草稿已保存。` : "版本已保存。"); await load(); }} />}
  </>;
}

function ReleaseEditor({ token, release, onClose, onSaved }: { token: string; release: Release | null; onClose: () => void; onSaved: (release: Release) => void }) {
  const [form, setForm] = useState<ReleaseForm>(() => release ? { version: release.version, channel: release.channel, notes: release.notes, min_supported_version: release.min_supported_version, rollout_percent: release.rollout_percent, artifacts: release.artifacts.map((artifact) => ({ ...artifact })) } : emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function artifact(target: Artifact["target"], arch: Artifact["arch"]) {
    return form.artifacts.find((item) => item.target === target && item.arch === arch);
  }
  function toggleArtifact(target: Artifact["target"], arch: Artifact["arch"], enabled: boolean) {
    setForm((current) => ({ ...current, artifacts: enabled ? [...current.artifacts, { target, arch, url: "", signature: "" }] : current.artifacts.filter((item) => item.target !== target || item.arch !== arch) }));
  }
  function updateArtifact(target: Artifact["target"], arch: Artifact["arch"], changes: Partial<Artifact>) {
    setForm((current) => ({ ...current, artifacts: current.artifacts.map((item) => item.target === target && item.arch === arch ? { ...item, ...changes } : item) }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      const result = await apiRequest<Release>(release ? `/admin/desktop-releases/${release.id}` : "/admin/desktop-releases", { method: release ? "PATCH" : "POST", body: JSON.stringify(form) }, token);
      onSaved(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (!saving && event.target === event.currentTarget) onClose(); }}><form className="modal release-editor-modal" onSubmit={submit}>
    <header><div><span className="kicker">{release ? "EDIT RELEASE DRAFT" : "NEW RELEASE DRAFT"}</span><h2>{release ? `编辑 v${release.version}` : "新建客户端版本"}</h2><p>版本发布后即锁定。私钥只保留在 CI，不要粘贴到这里。</p></div><button type="button" disabled={saving} onClick={onClose}>×</button></header>
    <div className="three-columns"><label>版本号<input value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} placeholder="1.2.3" required /></label><label>渠道<input value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value })} placeholder="stable" required /></label><label>灰度比例（%）<input type="number" min="1" max="100" value={form.rollout_percent} onChange={(event) => setForm({ ...form, rollout_percent: Number(event.target.value) })} required /></label></div>
    <label>最低可运行版本<input value={form.min_supported_version} onChange={(event) => setForm({ ...form, min_supported_version: event.target.value })} placeholder="0.0.0" required /><small>当前版本低于此值时将强制升级。普通可选更新保持 0.0.0。</small></label>
    <label>更新说明<textarea className="compact-textarea" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} maxLength={20000} placeholder="修复内容、功能变化和升级注意事项" /></label>
    <section className="release-artifacts"><header><strong>签名更新包</strong><small>至少配置一个平台后才能发布；签名内容来自构建产物旁的 .sig 文件。</small></header>{artifactOptions.map((option) => {
      const value = artifact(option.target, option.arch);
      return <article key={`${option.target}-${option.arch}`} className={value ? "enabled" : ""}><label className="release-artifact-toggle"><input type="checkbox" checked={Boolean(value)} onChange={(event) => toggleArtifact(option.target, option.arch, event.target.checked)} /><span><strong>{option.label}</strong><small>{option.hint}</small></span></label>{value && <><label>HTTPS 更新包地址<input type="url" value={value.url} onChange={(event) => updateArtifact(option.target, option.arch, { url: event.target.value })} placeholder="https://cdn.example.com/releases/..." required /></label><label>Updater 签名<textarea className="release-signature" value={value.signature} onChange={(event) => updateArtifact(option.target, option.arch, { signature: event.target.value })} placeholder="粘贴 .sig 文件完整内容" required /></label></>}</article>;
    })}</section>
    {error && <div className="form-error" role="alert">{error}</div>}
    <footer><button type="button" className="secondary" disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存草稿"}</button></footer>
  </form></div>;
}
