import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clapperboard, FileText, Image as ImageIcon, LoaderCircle, Search } from "lucide-react";
import type { CanonicalProject, GenerationRecord, ImageGenerationTask, Shot } from "@aivs/schemas";
import { readProjectAsset } from "../services/backend";

type Status = "pending" | "running" | "ready" | "failed";
type Card = {
  shot: Shot; index: number; status: Status; imagePath?: string; videoPath?: string;
  start: number; scene: string; cast: string; props: string; hasVideo: boolean; imageBusy: boolean; videoBusy: boolean;
};
const statusLabels: Record<Status, string> = { pending: "待制作", running: "生成中", ready: "视频就绪", failed: "生成失败" };
const active = (status?: string) => ["PENDING", "RUNNING", "REMOTE_PROCESSING", "DOWNLOADING", "QUEUED", "PROCESSING", "SUBMITTED"].includes(status || "");

export function DirectorWorkbench({ canonical, projectPath, records, imageTasks, selectedId, imagePrompt, videoPrompt, getVideoPrompt, actions, notices, generatingImageId, generatingVideoId, onSelect, onOpenDetail, onGenerateImage, onGenerateVideo, onEditVideoPrompt }: {
  canonical: CanonicalProject; projectPath: string; records: GenerationRecord[]; imageTasks: ImageGenerationTask[];
  selectedId?: string; imagePrompt?: string; videoPrompt?: string; getVideoPrompt?: (shot: Shot) => string; actions?: ReactNode; notices?: ReactNode;
  generatingImageId?: string; generatingVideoId?: string; onSelect: (id: string) => void; onOpenDetail?: (id: string) => void;
  onGenerateImage?: (id: string) => void; onGenerateVideo?: (id: string) => void; onEditVideoPrompt?: (id: string) => void;
}) {
  const [viewMode, setViewMode] = useState<"list" | "large">("list");
  const [search, setSearch] = useState("");
  const [sceneFilter, setSceneFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const selectedCardRef = useRef<HTMLButtonElement>(null);
  const scenes = useMemo(() => new Map(canonical.scenes.map(scene => [scene.id, scene])), [canonical.scenes]);
  const characters = useMemo(() => new Map(canonical.characters.map(character => [character.id, character.name])), [canonical.characters]);
  const props = useMemo(() => new Map((canonical.props ?? []).map(prop => [prop.id, prop.name])), [canonical.props]);
  let cursor = 0;
  const cards: Card[] = canonical.shots.map((shot, index) => {
    const targetRecords = records.filter(record => record.target_type === "shot" && record.target_id === shot.id);
    const video = targetRecords.find(record => record.media_type === "video");
    const image = targetRecords.find(record => record.media_type === "image");
    const imageTask = imageTasks.find(task => task.target_type === "shot" && task.target_id === shot.id);
    const completedVideo = targetRecords.find(record => record.media_type === "video" && record.status === "COMPLETED" && record.result_relative_path);
    const completedImage = targetRecords.find(record => record.media_type === "image" && record.status === "COMPLETED" && record.result_relative_path);
    const hasVideo = !!shot.video_assets?.length || !!completedVideo;
    const imageBusy = active(image?.status) || active(imageTask?.status) || generatingImageId === shot.id;
    const videoBusy = active(video?.status) || generatingVideoId === shot.id;
    const status: Status = videoBusy || imageBusy ? "running" : video?.status === "FAILED" || image?.status === "FAILED" || imageTask?.status === "FAILED" ? "failed" : hasVideo ? "ready" : "pending";
    const start = cursor;
    cursor += Number.isFinite(shot.duration) ? shot.duration : 0;
    return {
      shot, index, status, start, hasVideo, imageBusy, videoBusy,
      imagePath: completedImage?.result_relative_path || imageTasks.find(task => task.target_type === "shot" && task.target_id === shot.id && task.status === "COMPLETED" && task.result_relative_path)?.result_relative_path || shot.reference_assets?.[0],
      videoPath: completedVideo?.result_relative_path || shot.video_assets?.[0],
      scene: scenes.get(shot.scene_id)?.name || "未指定场景",
      cast: shot.character_ids.map(id => characters.get(id) || id).join("、") || "无出镜角色",
      props: (shot.prop_ids ?? []).map(id => props.get(id) || id).join("、") || "无道具",
    };
  });
  const filtered = cards.filter(card => (!sceneFilter || card.shot.scene_id === sceneFilter) && (!statusFilter || card.status === statusFilter)
    && `${card.shot.id} ${card.scene} ${card.cast} ${card.shot.visual} ${card.shot.dialogue}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = cards.find(card => card.shot.id === selectedId) ?? filtered[0] ?? cards[0];

  useEffect(() => {
    if (filtered.length && !filtered.some(card => card.shot.id === selected?.shot.id)) onSelect(filtered[0]!.shot.id);
  }, [filtered, onSelect, selected?.shot.id]);
  useEffect(() => { selectedCardRef.current?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" }); }, [selected?.shot.id]);

  return <section className="director-workbench" aria-label="导演工作台">
    <header className="director-heading">
      <div className="director-heading-copy"><span className="section-label">DIRECTOR WORKBENCH</span><h2>导演工作台</h2><p>先纵览全片制作状态，再检查当前分镜画面、视频与拍摄参数。</p></div>
      <div className="director-heading-tools"><div className="director-stats" aria-label="分镜制作数据"><span><b>{cards.length}</b> 个分镜</span><span><b>{Number(cursor.toFixed(1))}</b> 秒</span><span><b>{cards.filter(card => card.hasVideo).length}/{cards.length}</b> 视频就绪</span><span><b>{cards.filter(card => card.status === "running").length}</b> 生成中</span></div><div className="director-view-mode" role="group" aria-label="显示模式"><button className={viewMode === "list" ? "active" : ""} type="button" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}>列表</button><button className={viewMode === "large" ? "active" : ""} type="button" aria-pressed={viewMode === "large"} onClick={() => setViewMode("large")}>大图</button></div>{actions && <div className="director-actions">{actions}</div>}</div>
    </header>
    {notices && <div className="director-notices">{notices}</div>}
    <div className="director-toolbar"><label className="director-search"><Search size={17} /><input aria-label="搜索分镜" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索画面、台词、角色或分镜编号" /></label><label><span>场景</span><select aria-label="按场景筛选" value={sceneFilter} onChange={event => setSceneFilter(event.target.value)}><option value="">全部场景</option>{canonical.scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select></label><label><span>制作状态</span><select aria-label="按制作状态筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="director-result-count">显示 {filtered.length} / {cards.length} 镜</span></div>
    {viewMode === "large" && (selected ? <DirectorSelectedShot projectPath={projectPath} card={selected} aspectRatio={canonical.story.aspect_ratio || selected.shot.aspect_ratio || "9:16"} imagePrompt={imagePrompt ?? selected.shot.image_prompt} videoPrompt={videoPrompt ?? selected.shot.video_prompt} onOpenDetail={onOpenDetail} /> : <div className="director-empty"><Clapperboard size={30} /><p>还没有分镜，请先解析剧本或添加分镜。</p></div>)}
    {viewMode === "large" && (filtered.length ? <div className="director-strip" aria-label="全部分镜卡片">{filtered.map(card => <button ref={card.shot.id === selected?.shot.id ? selectedCardRef : undefined} className={`director-card ${card.status} ${card.shot.id === selected?.shot.id ? "selected" : ""}`} key={card.shot.id} type="button" aria-pressed={card.shot.id === selected?.shot.id} onClick={() => onSelect(card.shot.id)} onDoubleClick={() => onOpenDetail?.(card.shot.id)} aria-label={`选择第 ${card.index + 1} 镜：${card.scene}`}>
      <div className="director-card-image"><DirectorThumbnail projectPath={projectPath} relativePath={card.imagePath} shot={card.shot} /><span className="director-shot-number">{String(card.index + 1).padStart(2, "0")}</span><span className={`director-status ${card.status}`}>{card.status === "running" ? <LoaderCircle size={12} className="spin" /> : card.status === "ready" ? <CheckCircle2 size={12} /> : card.status === "failed" ? <AlertTriangle size={12} /> : <Clapperboard size={12} />}{statusLabels[card.status]}</span><span className="director-duration">{card.shot.duration} 秒</span></div>
      <div className="director-card-body"><div className="director-card-title"><strong>{card.scene}</strong><ArrowUpRight size={15} /></div><p className="director-visual">{card.shot.visual || "尚未填写画面描述"}</p><footer><span>{card.shot.id}</span><span>{Number(card.start.toFixed(1))}–{Number((card.start + card.shot.duration).toFixed(1))}s</span></footer></div>
    </button>)}</div> : <DirectorNoResults onClear={() => { setSearch(""); setSceneFilter(""); setStatusFilter(""); }} />)}
    {viewMode === "list" && (filtered.length ? <div className="director-list-grid" aria-label="分镜卡片列表">{filtered.map(card => <DirectorListCard key={card.shot.id} card={card} projectPath={projectPath} videoPrompt={getVideoPrompt?.(card.shot) ?? card.shot.video_prompt ?? ""} onOpen={() => (onOpenDetail ?? onSelect)(card.shot.id)} onGenerateImage={onGenerateImage} onGenerateVideo={onGenerateVideo} onEditVideoPrompt={onEditVideoPrompt} />)}</div> : <DirectorNoResults onClear={() => { setSearch(""); setSceneFilter(""); setStatusFilter(""); }} />)}
  </section>;
}

function DirectorNoResults({ onClear }: { onClear: () => void }) {
  return <div className="director-empty compact"><Clapperboard size={26} /><p>没有符合条件的分镜</p><button className="secondary-button" type="button" onClick={onClear}>清除筛选</button></div>;
}

function DirectorListCard({ card, projectPath, videoPrompt, onOpen, onGenerateImage, onGenerateVideo, onEditVideoPrompt }: {
  card: Card; projectPath: string; videoPrompt: string; onOpen: () => void;
  onGenerateImage?: (id: string) => void; onGenerateVideo?: (id: string) => void; onEditVideoPrompt?: (id: string) => void;
}) {
  const tooltipId = `director-prompt-${card.shot.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const activate = (event: KeyboardEvent<HTMLElement>) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } };
  const action = (callback?: (id: string) => void) => (event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); callback?.(card.shot.id); };
  return <article className={`director-list-card ${card.status}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={activate} aria-label={`进入 ${card.shot.id} 分镜详情`}>
    <div className="director-list-media"><DirectorListMedia projectPath={projectPath} relativePath={card.videoPath ?? card.imagePath} mediaType={card.videoPath ? "video" : "image"} shotId={card.shot.id} /><span className="director-list-shot">{card.shot.id}</span><span className={`director-status ${card.status}`}>{card.status === "running" ? <LoaderCircle size={12} className="spin" /> : card.status === "ready" ? <CheckCircle2 size={12} /> : card.status === "failed" ? <AlertTriangle size={12} /> : <Clapperboard size={12} />}{statusLabels[card.status]}</span></div>
    <div className="director-list-body"><div className="director-list-tags"><span>{card.shot.duration} 秒</span><span title={card.shot.camera_movement || "未设置运镜"}>{card.shot.camera_movement || "未设置运镜"}</span><span title={card.scene}>{card.scene}</span><span title={card.cast}>{card.cast}</span></div>
      <div className="director-list-prompt" tabIndex={0} aria-describedby={videoPrompt ? tooltipId : undefined}><p>{videoPrompt || "尚未填写视频生成提示词"}</p>{videoPrompt && <div id={tooltipId} role="tooltip">{videoPrompt}</div>}</div>
      <div className="director-list-actions"><button type="button" onClick={action(onGenerateImage)} disabled={!onGenerateImage || card.imageBusy}>生成分镜图</button><button type="button" onClick={action(onGenerateVideo)} disabled={!onGenerateVideo || card.videoBusy}>生成视频</button><button type="button" onClick={action(onEditVideoPrompt)} disabled={!onEditVideoPrompt}>编辑提示词</button></div>
    </div>
  </article>;
}

function DirectorSelectedShot({ projectPath, card, aspectRatio, imagePrompt, videoPrompt, onOpenDetail }: {
  projectPath: string; card: Card; aspectRatio: string; imagePrompt?: string; videoPrompt?: string; onOpenDetail?: (id: string) => void;
}) {
  const shot = card.shot;
  return <section className="director-selected" aria-label={`当前分镜 ${shot.id} 详情`}>
    <header><div><span className="section-label">SELECTED SHOT · {String(card.index + 1).padStart(2, "0")}</span><h3>{shot.id} · {card.scene}</h3></div>{onOpenDetail && <button className="secondary-button" type="button" onClick={() => onOpenDetail(shot.id)}><FileText size={16} />进入完整分镜详情</button>}</header>
    <div className="director-detail-grid">
      <div className="director-detail-column director-detail-left">
        <DirectorDetailBlock label="分镜图" media><DirectorAsset projectPath={projectPath} relativePath={card.imagePath} mediaType="image" shotId={shot.id} /></DirectorDetailBlock>
        <DirectorDetailBlock label="分镜图提示词"><p>{imagePrompt || "尚未填写分镜图提示词"}</p></DirectorDetailBlock>
      </div>
      <div className="director-detail-column director-detail-center">
        <DirectorDetailBlock label="分镜视频" media large><DirectorAsset projectPath={projectPath} relativePath={card.videoPath} mediaType="video" shotId={shot.id} /></DirectorDetailBlock>
        <DirectorDetailBlock label="视频生成提示词" className="prompt"><p>{videoPrompt || "尚未填写视频生成提示词"}</p></DirectorDetailBlock>
      </div>
      <aside className="director-detail-column director-detail-right">
        <DirectorParameter label="时长 / 屏幕比例" value={`时长 ${shot.duration} 秒 · 比例 ${aspectRatio}`} />
        <DirectorParameter label="景别 / 机位 / 运镜" value={`景别 ${shot.shot_size || "未设置"} · 机位 ${shot.camera_angle || "未设置"} · 运镜 ${shot.camera_movement || "未设置"}`} multiline />
        <DirectorParameter label="场景锁定" value={`${shot.scene_id} · ${card.scene}`} multiline />
        <DirectorParameter label="人物锁定" value={card.cast} multiline />
        <DirectorParameter label="道具图" value={card.props} multiline />
        <DirectorParameter label="生成约束" value={shot.constraints || shot.negative_prompt || "无"} multiline />
      </aside>
    </div>
  </section>;
}

function DirectorDetailBlock({ label, children, media = false, large = false, className = "" }: { label: string; children: ReactNode; media?: boolean; large?: boolean; className?: string }) {
  return <section className={`director-detail-block${media ? " media" : ""}${large ? " large" : ""}${className ? ` ${className}` : ""}`}><strong>{label}</strong><div>{children}</div></section>;
}

function DirectorParameter({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return <div className={`director-parameter${multiline ? " multiline" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function DirectorAsset({ projectPath, relativePath, mediaType, shotId }: { projectPath: string; relativePath?: string; mediaType: "image" | "video"; shotId: string }) {
  const asset = useQuery({ queryKey: ["project-asset", projectPath, relativePath], queryFn: () => readProjectAsset(projectPath, relativePath!), enabled: !!relativePath, staleTime: Infinity });
  if (asset.data) return mediaType === "video" ? <video src={asset.data} controls preload="metadata" aria-label={`${shotId} 分镜视频`} /> : <img src={asset.data} alt={`${shotId} 分镜图`} />;
  return <div className="director-asset-empty">{asset.isFetching ? <LoaderCircle className="spin" size={25} /> : mediaType === "image" ? <ImageIcon size={27} /> : <Clapperboard size={27} />}<span>{asset.isFetching ? "正在加载" : mediaType === "image" ? "待生成分镜图" : "待生成分镜视频"}</span></div>;
}

function DirectorListMedia({ projectPath, relativePath, mediaType, shotId }: { projectPath: string; relativePath?: string; mediaType: "image" | "video"; shotId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "120px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const asset = useQuery({ queryKey: ["project-asset", projectPath, relativePath], queryFn: () => readProjectAsset(projectPath, relativePath!), enabled: visible && !!relativePath, staleTime: Infinity });
  return <div ref={ref} className="director-list-media-content">{asset.data ? mediaType === "video" ? <video src={asset.data} controls preload="metadata" aria-label={`${shotId} 分镜视频`} onClick={event => event.stopPropagation()} /> : <img src={asset.data} alt={`${shotId} 分镜图`} loading="lazy" /> : <div className="director-list-media-empty">{asset.isFetching ? <LoaderCircle className="spin" size={25} /> : <Clapperboard size={27} />}<span>{asset.isFetching ? "正在加载" : asset.error ? "素材暂不可用" : "待生成"}</span></div>}</div>;
}

function DirectorThumbnail({ projectPath, relativePath, shot }: { projectPath: string; relativePath?: string; shot: Shot }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "160px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const image = useQuery({ queryKey: ["project-asset", projectPath, relativePath], queryFn: () => readProjectAsset(projectPath, relativePath!), enabled: visible && !!relativePath, staleTime: Infinity });
  return <div ref={ref} className="director-thumbnail">{image.data ? <img src={image.data} alt={`${shot.id} 分镜图`} loading="lazy" /> : <div className="director-thumbnail-empty"><ImageIcon size={25} /><span>{image.isFetching ? "正在加载画面" : "待生成分镜图"}</span></div>}</div>;
}
