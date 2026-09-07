import { useEffect, useState } from "react";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { Download, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";

const COHORT_STORAGE_KEY = "aivs.update-cohort";
let startupCheck: Promise<Update | null> | null = null;

function cohortId(): string {
  const existing = localStorage.getItem(COHORT_STORAGE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(COHORT_STORAGE_KEY, created);
  return created;
}

function checkForUpdate() {
  startupCheck ||= check({ headers: { "X-Update-Cohort": cohortId() }, timeout: 15_000 });
  return startupCheck;
}

function updateBody(update: Update): string {
  return typeof update.body === "string" && update.body.trim() ? update.body.trim() : "此版本包含稳定性与体验改进。";
}

export function DesktopUpdateHost() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | undefined>();
  const [error, setError] = useState("");
  const mandatory = update?.rawJson.mandatory === true;

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    setChecking(true);
    void checkForUpdate()
      .then(setUpdate)
      .catch((cause) => console.warn("启动更新检查失败，将在下次启动时重试", cause))
      .finally(() => setChecking(false));
  }, []);

  async function install() {
    if (!update || installing) return;
    setInstalling(true); setError(""); setDownloaded(0); setTotal(undefined);
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") setTotal(event.data.contentLength);
        if (event.event === "Progress") setDownloaded((current) => current + event.data.chunkLength);
      }, { headers: { "X-Update-Cohort": cohortId() }, timeout: 120_000 });
      await relaunch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "下载或安装更新失败");
      setInstalling(false);
    }
  }

  function later() {
    if (!update || mandatory || installing) return;
    void update.close();
    setUpdate(null);
  }

  if (checking || !update) return null;
  const percent = total ? Math.min(100, Math.round(downloaded / total * 100)) : undefined;
  return <div className="desktop-update-backdrop" role="presentation">
    <section className="desktop-update-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-update-title">
      <header><span><ShieldCheck size={20} /></span><div><small>{mandatory ? "REQUIRED SECURITY UPDATE" : "NEW VERSION AVAILABLE"}</small><h2 id="desktop-update-title">发现新版本 v{update.version}</h2><p>当前版本 v{update.currentVersion}{mandatory ? " 已低于最低可运行版本，需要升级后继续使用。" : "，建议现在升级以获得最新修复。"}</p></div></header>
      <div className="desktop-update-notes"><strong>更新内容</strong><p>{updateBody(update)}</p></div>
      {installing && <div className="desktop-update-progress"><div><span style={{ width: `${percent ?? 12}%` }} /></div><small>{percent === undefined ? "正在下载签名更新包…" : `已下载 ${percent}%`}</small></div>}
      {error && <div className="desktop-update-error" role="alert">{error}</div>}
      <footer>
        {!mandatory && !installing && <button className="secondary-button" type="button" onClick={later}>稍后提醒</button>}
        {mandatory && error && <button className="secondary-button" type="button" onClick={() => void exit(0)}>退出客户端</button>}
        <button className="primary-button" type="button" disabled={installing} onClick={() => void install()}>{installing ? <><LoaderCircle className="spin" size={17} /> 正在升级…</> : error ? <><RefreshCw size={17} /> 重试升级</> : <><Download size={17} /> 立即升级并重启</>}</button>
      </footer>
    </section>
  </div>;
}
