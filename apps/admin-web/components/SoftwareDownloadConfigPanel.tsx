"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type DownloadConfig = {
  windows_download_enabled: boolean;
  windows_download_url: string;
  macos_download_enabled: boolean;
  macos_download_url: string;
  download_page_url: string;
  revision: number;
  updated_at?: string;
};

export function SoftwareDownloadConfigPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<DownloadConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError(""); setMessage("");
    try { setConfig(await apiRequest<DownloadConfig>("/admin/distribution/downloads", {}, token)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "读取软件下载配置失败"); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  async function copyDownloadPage() {
    if (!config?.download_page_url) return;
    try {
      await navigator.clipboard.writeText(config.download_page_url);
      setError(""); setMessage("下载页面链接已复制。可在链接后追加 ?invite_code=8位邀请码。 ");
    } catch { setError("复制失败，请手动选择下载页面链接复制。"); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config || saving) return;
    if (config.windows_download_enabled && !config.windows_download_url.trim()) { setError("开启 Windows 下载前请先配置安装包地址"); return; }
    if (config.macos_download_enabled && !config.macos_download_url.trim()) { setError("开启 macOS 下载前请先配置安装包地址"); return; }
    setSaving(true); setError(""); setMessage("");
    try {
      setConfig(await apiRequest<DownloadConfig>("/admin/distribution/downloads", { method: "PATCH", body: JSON.stringify(config) }, token));
      setMessage("安装包配置已保存，开启的平台会立即显示在公开下载页面。 ");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存软件下载配置失败"); }
    finally { setSaving(false); }
  }

  const enabledCount = Number(config?.windows_download_enabled) + Number(config?.macos_download_enabled);
  return <section className="section-card software-download-config">
    <header><div><span className="kicker">CLIENT DOWNLOADS</span><h2>安装包配置</h2><p>分别控制 Windows 和 macOS 版本是否对外开放；只有开启的平台才会出现在下载页面。</p></div>{config && <span className={`status ${enabledCount ? "good" : "bad"}`}>{enabledCount ? `已开放 ${enabledCount} 个版本` : "下载已关闭"}</span>}</header>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    {loading ? <div className="loading-card"><span className="spinner" />正在读取安装包配置…</div> : config && <form onSubmit={save}>
      <div className="download-page-link"><label>独立下载页面<input value={config.download_page_url} readOnly aria-label="独立下载页面链接" /></label><button type="button" className="secondary" onClick={() => void copyDownloadPage()}>一键复制</button><small>不带邀请码时页面会显示选填的邀请码输入框；也可使用 <code>?invite_code=XXXXXXXX</code> 预填并锁定邀请码。</small></div>
      <fieldset className="download-platform-grid" disabled={saving}>
        <article className={config.windows_download_enabled ? "enabled" : ""}><label className="download-version-switch"><input type="checkbox" checked={config.windows_download_enabled} onChange={event => setConfig({ ...config, windows_download_enabled: event.target.checked })} /><span><strong>开放 Windows 版本</strong><small>开启后在下载页面显示 Windows 下载按钮</small></span></label><label>Windows 安装包下载地址<input type="url" maxLength={1000} value={config.windows_download_url} onChange={event => setConfig({ ...config, windows_download_url: event.target.value })} placeholder="https://download.example.com/dreamotion-setup.exe" /><small>支持 EXE、MSI 或完整 HTTPS 下载链接。</small></label></article>
        <article className={config.macos_download_enabled ? "enabled" : ""}><label className="download-version-switch"><input type="checkbox" checked={config.macos_download_enabled} onChange={event => setConfig({ ...config, macos_download_enabled: event.target.checked })} /><span><strong>开放 macOS 版本</strong><small>开启后在下载页面显示 macOS 下载按钮</small></span></label><label>macOS 安装包下载地址<input type="url" maxLength={1000} value={config.macos_download_url} onChange={event => setConfig({ ...config, macos_download_url: event.target.value })} placeholder="https://download.example.com/dreamotion.dmg" /><small>支持 DMG、PKG 或完整 HTTPS 下载链接。</small></label></article>
      </fieldset>
      <p>可以暂时关闭全部版本，已填写的安装包地址会保留，重新开启后即可继续使用。</p>
      {config.updated_at && <small className="software-download-updated">最近更新：{new Date(config.updated_at).toLocaleString("zh-CN", { hour12: false })}</small>}
      <div className="software-download-actions"><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存安装包配置"}</button><button className="secondary" type="button" disabled={saving} onClick={() => void load()}>重新读取</button></div>
    </form>}
  </section>;
}
