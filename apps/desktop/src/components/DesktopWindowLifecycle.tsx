import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window";
import { useIsMutating } from "@tanstack/react-query";
import { useWorkflowQuietCount } from "../services/workflowQuiet";

const isNativeDesktop = () => "__TAURI_INTERNALS__" in window;

export function DesktopWindowLifecycle() {
  const [confirmingClose, setConfirmingClose] = useState(false);
  const runningTaskCount = useWorkflowQuietCount();
  const pendingOperationCount = useIsMutating();
  const closeDialog = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isNativeDesktop()) return;
    let disposed = false;
    let removeListener: (() => void) | undefined;
    const onClose = (event: CloseRequestedEvent) => {
      event.preventDefault();
      setConfirmingClose(true);
    };
    void getCurrentWindow().onCloseRequested(onClose).then(unlisten => {
      if (disposed) unlisten(); else removeListener = unlisten;
    });
    return () => { disposed = true; removeListener?.(); };
  }, []);

  useEffect(() => {
    if (!isNativeDesktop()) return;
    const status = runningTaskCount > 0 ? `正在运行 ${runningTaskCount} 个自动制作任务` : pendingOperationCount > 0 ? `正在处理 ${pendingOperationCount} 个客户端任务` : "当前没有运行中的任务";
    void invoke("set_tray_status", { status }).catch(error => console.error("更新托盘状态失败", error));
  }, [pendingOperationCount, runningTaskCount]);

  useEffect(() => {
    if (confirmingClose) closeDialog.current?.focus();
  }, [confirmingClose]);

  if (!confirmingClose) return null;
  const hideToTray = async () => {
    setConfirmingClose(false);
    try { await getCurrentWindow().hide(); }
    catch (error) { console.error("隐藏到系统托盘失败", error); }
  };
  const exit = () => { void invoke("exit_application"); };
  return createPortal(
    <div className="modal-backdrop close-behavior-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setConfirmingClose(false); }}>
      <section ref={closeDialog} className="close-behavior-dialog" role="dialog" aria-modal="true" aria-labelledby="close-behavior-title" tabIndex={-1} onKeyDown={event => { if (event.key === "Escape") setConfirmingClose(false); }}>
        <span>关闭客户端</span>
        <h2 id="close-behavior-title">需要退出客户端吗？</h2>
        <p>隐藏到系统托盘后，后台任务仍会继续运行。将鼠标移到右下角托盘图标可查看任务状态，双击图标可重新显示客户端。</p>
        <div className="close-behavior-actions">
          <button type="button" className="secondary-button danger-button" onClick={exit}>直接退出</button>
          <button type="button" className="primary-button" onClick={() => void hideToTray()}>隐藏到系统托盘</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
