import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { QRCodeCanvas } from "qrcode.react";
import { Check, Copy, Download, Image as ImageIcon, LoaderCircle, Share2, Upload, X } from "lucide-react";
import { getReferralSummary } from "../services/platform";
import {
  choosePromotionPosterFile,
  importPromotionPoster,
  listPromotionPosters,
  readPromotionPosterDataUrl,
  savePromotionPoster,
  type PromotionPosterFile,
} from "../services/backend";
import { promotionPosterHasQr, renderPromotionPoster } from "../promotionPoster";
import poster001 from "../../../../assets/images/poster/001.png";
import poster002 from "../../../../assets/images/poster/002.png";
import poster003 from "../../../../assets/images/poster/003.png";
import poster004 from "../../../../assets/images/poster/004.png";
import poster005 from "../../../../assets/images/poster/005.png";
import poster006 from "../../../../assets/images/poster/006.png";
import poster007 from "../../../../assets/images/poster/007.png";
import poster008 from "../../../../assets/images/poster/008.png";

type PosterOption = {
  id: string;
  label: string;
  source: string;
  posterIndex: number;
  customPath?: string;
};

const builtInSources = [poster001, poster002, poster003, poster004, poster005, poster006, poster007, poster008];
const builtInPosters: PosterOption[] = builtInSources.map((source, position) => ({
  id: `built-in-${position + 1}`,
  label: String(position + 1).padStart(3, "0"),
  source,
  posterIndex: position + 1,
}));

function customPosterOption(file: PromotionPosterFile): PosterOption {
  return {
    id: `custom-${file.id}`,
    label: file.name,
    source: convertFileSrc(file.path),
    posterIndex: 0,
    customPath: file.path,
  };
}

export function PromotionPosterModal({ onClose }: { onClose: () => void }) {
  const summary = useQuery({ queryKey: ["referral-summary", "promotion-poster"], queryFn: getReferralSummary, staleTime: 30_000 });
  const customPosters = useQuery({ queryKey: ["custom-promotion-posters"], queryFn: listPromotionPosters });
  const [showPosters, setShowPosters] = useState(false);
  const [selectedPosterId, setSelectedPosterId] = useState<string>();
  const [preview, setPreview] = useState("");
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const generationRevision = useRef(0);
  const qrCanvas = useRef<HTMLCanvasElement>(null);
  const posterOptions = [...builtInPosters, ...(customPosters.data || []).map(customPosterOption)];
  const selectedPoster = posterOptions.find((poster) => poster.id === selectedPosterId);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => { generationRevision.current += 1; window.removeEventListener("keydown", closeOnEscape); };
  }, [onClose]);

  const copyLink = async () => {
    if (!summary.data?.invitation_url) return;
    try {
      await navigator.clipboard.writeText(summary.data.invitation_url);
      setCopied(true);
      setFeedback("推广链接已复制");
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setFeedback("复制失败，请选中链接后手动复制");
    }
  };

  const choosePoster = async (poster: PosterOption) => {
    if (!summary.data?.invitation_url) return;
    const revision = ++generationRevision.current;
    setSelectedPosterId(poster.id);
    setPreview("");
    setFeedback("");
    setGenerating(true);
    try {
      const source = poster.customPath ? await readPromotionPosterDataUrl(poster.customPath) : poster.source;
      const result = await renderPromotionPoster(source, qrCanvas.current, poster.posterIndex);
      if (generationRevision.current === revision) setPreview(result);
    } catch (error) {
      if (generationRevision.current === revision) setFeedback(error instanceof Error ? error.message : "推广海报生成失败");
    } finally {
      if (generationRevision.current === revision) setGenerating(false);
    }
  };

  const addPoster = async () => {
    setFeedback("");
    try {
      const sourcePath = await choosePromotionPosterFile();
      if (!sourcePath) return;
      setImporting(true);
      const imported = await importPromotionPoster(sourcePath);
      await customPosters.refetch();
      setFeedback("本地海报已添加到推广海报列表");
      await choosePoster(customPosterOption(imported));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "添加本地推广海报失败");
    } finally {
      setImporting(false);
    }
  };

  const savePoster = async () => {
    if (!preview || !selectedPoster) return;
    setSaving(true);
    setFeedback("");
    try {
      const path = await savePromotionPoster(preview, selectedPoster.label);
      if (path) setFeedback(`推广海报已保存：${path}`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "推广海报保存失败");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(<div className="modal-backdrop promotion-poster-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="promotion-poster-modal" role="dialog" aria-modal="true" aria-labelledby="promotion-poster-title">
      <header><div><span className="eyebrow">PROMOTION CENTER</span><h2 id="promotion-poster-title">推广赚钱</h2><p>分享你的专属推广链接，好友注册和消费后可按平台规则获得奖励。</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭推广弹窗"><X size={18} /></button></header>
      <div className="promotion-poster-body">
        <section className="promotion-link-card">
          <div><Share2 size={20} /><div><strong>我的专属推广链接</strong><span>链接已自动绑定你的邀请码</span></div></div>
          {summary.isLoading ? <div className="promotion-loading"><LoaderCircle className="spin" size={18} />正在读取推广链接…</div> : summary.error ? <div className="error-banner">{summary.error instanceof Error ? summary.error.message : "推广链接读取失败"}</div> : <div className="promotion-link-copy"><input readOnly value={summary.data?.invitation_url || ""} onFocus={(event) => event.currentTarget.select()} /><button className="secondary-button" type="button" onClick={() => void copyLink()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "已复制" : "一键复制"}</button></div>}
        </section>
        {!showPosters ? <button className="primary-button promotion-get-posters" type="button" disabled={!summary.data?.invitation_url} onClick={() => setShowPosters(true)}><ImageIcon size={18} />获取推广海报</button> : <section className="promotion-poster-workspace">
          <section className="promotion-poster-picker">
            <header><div><strong>选择推广海报</strong><span>预设海报 001–004 含专属二维码；自定义海报保持原图。</span></div><div className="promotion-poster-picker-actions"><b>共 {posterOptions.length} 款</b><button className="secondary-button" type="button" disabled={importing} onClick={() => void addPoster()}>{importing ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}{importing ? "添加中…" : "添加本地海报"}</button></div></header>
            {customPosters.error && <div className="error-banner">{customPosters.error instanceof Error ? customPosters.error.message : "读取自定义海报失败"}</div>}
            <div className="promotion-poster-grid">{posterOptions.map((poster) => { const withQr = promotionPosterHasQr(poster.posterIndex); return <button className={selectedPosterId === poster.id ? "active" : ""} type="button" key={poster.id} onClick={() => void choosePoster(poster)} aria-pressed={selectedPosterId === poster.id}><span><img src={poster.source} alt={`推广海报 ${poster.label}`} loading="lazy" />{selectedPosterId === poster.id && <i><Check size={14} /></i>}</span><strong title={poster.label}>{poster.label}</strong><small>{withQr ? "含专属二维码" : poster.customPath ? "自定义海报" : "普通海报"}</small></button>; })}</div>
          </section>
          <section className="promotion-poster-preview"><header><div><strong>{selectedPoster ? `${selectedPoster.label} 海报预览` : "海报预览"}</strong><span>{selectedPoster ? promotionPosterHasQr(selectedPoster.posterIndex) ? "已嵌入专属推广二维码和注册提示文字" : "普通海报不嵌入二维码" : "从左侧选择一张海报查看最终效果"}</span></div></header><div>{generating ? <span className="promotion-loading"><LoaderCircle className="spin" size={20} />正在生成高清海报…</span> : preview ? <img src={preview} alt="生成后的推广海报预览" /> : <span className="promotion-preview-empty"><ImageIcon size={30} />请选择推广海报</span>}</div></section>
        </section>}
        {feedback && <div className={feedback.includes("失败") || feedback.includes("无法") || feedback.includes("无效") ? "error-banner" : "promotion-feedback"} role="status">{feedback}</div>}
        {summary.data?.invitation_url && <div className="promotion-qr-source" aria-hidden="true"><QRCodeCanvas ref={qrCanvas} value={summary.data.invitation_url} size={512} level="H" bgColor="#ffffff" fgColor="#111111" /></div>}
      </div>
      <footer><button className="secondary-button" type="button" onClick={onClose}>关闭</button>{showPosters && <button className="primary-button" type="button" disabled={!preview || saving || generating} onClick={() => void savePoster()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}{saving ? "正在保存…" : "保存当前海报"}</button>}</footer>
    </section>
  </div>, document.body);
}
