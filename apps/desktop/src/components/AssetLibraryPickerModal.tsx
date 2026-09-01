import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, Images, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { AssetLibraryItem } from "@aivs/schemas";
import { listAssetLibrary } from "../services/backend";

export function AssetLibraryPickerModal({ assetType, onConfirm, onClose }: {
  assetType: "scene" | "character";
  onConfirm: (asset: AssetLibraryItem) => Promise<void>;
  onClose: () => void;
}) {
  const library = useQuery({ queryKey: ["asset-library"], queryFn: listAssetLibrary, staleTime: 0 });
  const [selectedId, setSelectedId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const label = assetType === "scene" ? "场景图" : "角色图";
  const assets = (library.data ?? []).filter((asset) => asset.asset_type === assetType);
  const selected = assets.find((asset) => asset.id === selectedId);

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);

  const confirm = async () => {
    if (!selected || busy.current || library.isFetching || library.error) return;
    busy.current = true;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };

  return createPortal(<div className="modal-backdrop asset-detail-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy.current) onClose();
  }}>
    <section className="asset-picker-modal" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="asset-picker-title" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); if (!busy.current) onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><div><span className="eyebrow">ASSET LIBRARY</span><h2 id="asset-picker-title">从资产库选择{label}</h2><p>仅显示{label}，选中后点击“确认使用”。使用已有图片不扣积分。</p></div><button className="modal-close" type="button" aria-label="关闭资产库" disabled={submitting} onClick={onClose}><X size={18} /></button></header>
      <div className="asset-picker-body">
        <div className="project-center-toolbar"><span>{label} · {assets.length} 张</span><button className="secondary-button toolbar-button" type="button" disabled={submitting || library.isFetching} onClick={() => void library.refetch()}>{library.isFetching ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}刷新</button></div>
        {Boolean(library.error) && <div className="error-banner" role="alert">读取资产库失败，请刷新后重试。</div>}
        {error && <div className="error-banner" role="alert">导入失败：{error}</div>}
        {library.isLoading ? <div className="asset-library-empty"><LoaderCircle className="spin" size={20} />正在读取{label}…</div> : !assets.length ? <div className="asset-library-empty"><Images size={20} />资产库中暂无{label}</div> : <div className="asset-picker-grid">
          {assets.map((asset) => <button key={asset.id} className={`asset-library-card selecting${selectedId === asset.id ? " selected" : ""}`} type="button" disabled={submitting} aria-label={`选择${label}：${asset.name}`} aria-pressed={selectedId === asset.id} onClick={() => { setSelectedId(asset.id); setError(""); }}><span className="asset-selection-check">{selectedId === asset.id && <Check size={13} />}</span><span className="asset-library-image"><img src={convertFileSrc(asset.image_path)} alt={asset.name} loading="lazy" /></span><span className="asset-library-card-copy"><strong>{asset.name}</strong><span>{asset.prompt || "暂无描述"}</span></span></button>)}
        </div>}
      </div>
      <footer><span>{selected ? `已选择：${selected.name}` : `请选择一张${label}`}</span><div><button className="secondary-button" type="button" disabled={submitting} onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={!selected || submitting || library.isFetching || Boolean(library.error)} onClick={() => void confirm()}>{submitting && <LoaderCircle className="spin" size={16} />}{submitting ? "正在导入…" : "确认使用"}</button></div></footer>
    </section>
  </div>, document.body);
}
