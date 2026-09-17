import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Coins, Flame, LoaderCircle, Rocket, RotateCcw, Search, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import type { CreationSpec, ProjectBundle, VideoRemixOriginality, VideoRemixStoryboardDurationMode, VideoRemixTask } from "@aivs/schemas";
import { createCanonicalProject, createVideoRemixProject, createVideoRemixTask, deleteVideoRemixTask, listVideoRemixTasks, retryVideoRemixTask } from "../services/backend";
import { creditText } from "../services/creditCopy";
import { getCreditBalance, getScriptLibraryDetail, getScriptLibraryQuote, listScriptLibrary, listScriptLibraryCategories, useScriptLibraryItem, type ScriptLibraryItem, type ScriptLibraryProjectPayload } from "../services/platform";
import { workflowErrorMessage } from "../services/workflowState";
import { ImmediateCreditPurchaseButton } from "./CreditPurchaseHost";
import { ModelCreditNotice } from "./CreditConfirmationHost";

const PAGE_SIZE = 12;
const HOT_CATEGORY_CODE = "hot-fans";
const NEARBY_PAGE_COUNT = 5;
type ScriptLibraryRemixSource = { item: ScriptLibraryItem; content: string };

const message = workflowErrorMessage;
function durationText(seconds: number) {
  if (!seconds) return "时长待定";
  return seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`;
}

function nearbyPages(currentPage: number, pageCount: number): number[] {
  const count = Math.min(NEARBY_PAGE_COUNT, pageCount);
  const start = Math.max(1, Math.min(currentPage - Math.floor(count / 2), pageCount - count + 1));
  return Array.from({ length: count }, (_, index) => start + index);
}

export function ScriptLibraryPage({ projectDirectory, defaultSpec, onReady }: { projectDirectory: string; defaultSpec: CreationSpec; onReady: (bundle: ProjectBundle) => void }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");
  const [selected, setSelected] = useState<ScriptLibraryItem>();
  const [remixSource, setRemixSource] = useState<ScriptLibraryRemixSource>();
  const [confirmation, setConfirmation] = useState<{ item: ScriptLibraryItem; key: string }>();
  const [acceptedUsage, setAcceptedUsage] = useState<{ key: string; payload: ScriptLibraryProjectPayload }>();
  const categories = useQuery({ queryKey: ["script-library-categories"], queryFn: listScriptLibraryCategories, staleTime: 60_000 });
  const scripts = useQuery({ queryKey: ["script-library", query, category], queryFn: () => listScriptLibrary(query, category), staleTime: 15_000 });
  const detail = useQuery({ queryKey: ["script-library-detail", selected?.id], queryFn: () => getScriptLibraryDetail(selected!.id), enabled: Boolean(selected) });
  const quote = useQuery({ queryKey: ["script-library-quote"], queryFn: getScriptLibraryQuote, staleTime: 20_000 });
  const balance = useQuery({ queryKey: ["credit-balance", "script-library"], queryFn: getCreditBalance, enabled: Boolean(confirmation), refetchOnMount: "always" });
  const allScripts = scripts.data ?? [];
  const pageCount = Math.max(1, Math.ceil(allScripts.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageOptions = useMemo(() => nearbyPages(currentPage, pageCount), [currentPage, pageCount]);
  const visible = useMemo(() => allScripts.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), [allScripts, currentPage]);
  const create = useMutation({
    mutationFn: async ({ item, key }: { item: ScriptLibraryItem; key: string }) => {
      if (!quote.data) throw new Error("暂时无法获取剧本库积分价格");
      if (!projectDirectory.trim()) throw new Error("请先在系统设置中配置项目保存目录");
      const payload = acceptedUsage?.key === key
        ? acceptedUsage.payload
        : await useScriptLibraryItem(item.id, quote.data.credits, key);
      if (acceptedUsage?.key !== key) setAcceptedUsage({ key, payload });
      try {
        return await createCanonicalProject({
          root_path: projectDirectory,
          source_text: `从剧本库导入的规范剧本：《${payload.title}》`,
          creation_spec: { ...defaultSpec, project_name: payload.title, input_type: "SCRIPT", target_duration: payload.duration_seconds || defaultSpec.target_duration },
          canonical: payload.canonical,
        });
      } catch (error) {
        throw new Error(`积分扣除已确认，但本地项目创建失败：${message(error)}。请点击“重试创建项目”，本次重试不会重复扣分。`);
      }
    },
    onSuccess: (bundle) => {
      setConfirmation(undefined);
      setAcceptedUsage(undefined);
      void queryClient.invalidateQueries({ queryKey: ["script-library"] });
      void queryClient.invalidateQueries({ queryKey: ["credit-balance"] });
      onReady(bundle);
    },
  });
  const openConfirmation = (item: ScriptLibraryItem) => {
    create.reset();
    setAcceptedUsage(undefined);
    setConfirmation({ item, key: crypto.randomUUID() });
  };
  const closeConfirmation = () => {
    if (create.isPending) return;
    create.reset();
    setAcceptedUsage(undefined);
    setConfirmation(undefined);
  };
  const selectCategory = (id: string) => { setCategory(id); setPage(1); };
  const goToPage = (target: number) => setPage(Math.max(1, Math.min(pageCount, target)));
  const submitPageJump = () => {
    if (!pageInput.trim()) return;
    const target = Number(pageInput);
    if (!Number.isInteger(target)) return;
    goToPage(target);
    setPageInput("");
  };
  return <div className="script-library-page">
    <header className="script-library-hero"><div><span className="section-label">SCRIPT LIBRARY</span><h2>剧本库</h2><p>浏览经过规范化的剧本，查看内容后可一键生成完整项目。</p></div><div><Flame size={18} /><strong>{allScripts.length}</strong><span>个匹配剧本</span></div></header>
    <nav className="script-library-category-tabs" aria-label="剧本分类">
      <button type="button" className={!category ? "active" : ""} onClick={() => selectCategory("")}>全部</button>
      {(categories.data ?? []).map((item) => <button type="button" className={[category === item.id ? "active" : "", item.code === HOT_CATEGORY_CODE ? "hot-script-category" : ""].filter(Boolean).join(" ")} key={item.id} onClick={() => selectCategory(item.id)}>{item.name}<span>{item.script_count}</span></button>)}
    </nav>
    <div className="script-library-toolbar"><label><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索标题、简介或内容" /></label></div>
    {(scripts.error || categories.error || quote.error) && <div className="error-banner">{message(scripts.error || categories.error || quote.error)}</div>}
    {scripts.isLoading ? <div className="script-library-empty"><LoaderCircle className="spin" />正在读取剧本库…</div> : visible.length ? <>
      <div className="script-library-grid">{visible.map((item) => <article className={item.category_code === HOT_CATEGORY_CODE ? "hot-script-card" : ""} key={item.id} onClick={() => setSelected(item)}>
        <div><span>{item.category_name}</span><em><Flame size={13} />{Number(item.heat_score).toLocaleString()}</em></div>
        <h3>{item.title}</h3>
        <p>{item.summary || "暂无简介"}</p>
        <footer><span><Clock3 size={13} />{durationText(item.duration_seconds)}</span><span>{item.use_count} 次使用</span><button type="button" onClick={(event) => { event.stopPropagation(); openConfirmation(item); }} disabled={!quote.data || !projectDirectory} title={!projectDirectory ? "请先在系统设置中配置项目保存目录" : undefined}>生成项目 <ChevronRight size={14} /></button></footer>
      </article>)}</div>
      <div className="script-library-pagination" aria-label="剧本列表分页">
        <button type="button" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}><ChevronLeft size={15} />上一页</button>
        <div className="script-library-page-numbers" aria-label="邻近页码">{pageOptions.map((option) => <button type="button" className={option === currentPage ? "active" : ""} aria-current={option === currentPage ? "page" : undefined} key={option} onClick={() => goToPage(option)}>{option}</button>)}</div>
        <button type="button" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}>下一页<ChevronRight size={15} /></button>
        <span>第 {currentPage} / {pageCount} 页 · 共 {allScripts.length} 个剧本</span>
        <label className="script-library-page-jump">跳至<input type="number" min={1} max={pageCount} step={1} value={pageInput} placeholder={String(currentPage)} aria-label="跳转页码" onChange={(event) => setPageInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitPageJump(); } }} />页</label>
      </div>
    </> : <div className="script-library-empty"><BookOpen />没有找到匹配的剧本</div>}
    {selected && <div className="modal-backdrop script-library-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(undefined); }}><section className="script-library-detail"><header><div><span>{selected.category_name}</span><h2>{selected.title}</h2></div><button onClick={() => setSelected(undefined)}><X size={17} /></button></header><div><p>{selected.summary}</p>{detail.isLoading ? <div className="script-library-empty"><LoaderCircle className="spin" />正在读取内容…</div> : <pre>{detail.data?.content || "暂无内容预览"}</pre>}</div><footer><span>{quote.data ? `直接生成项目需要 ${creditText(quote.data.credits)} 积分` : "正在读取积分价格…"}</span><div className="script-library-detail-actions"><button className="secondary-button" type="button" onClick={() => { const content = detail.data?.content?.trim(); if (!content) return; setRemixSource({ item: selected, content }); setSelected(undefined); }} disabled={detail.isLoading || !detail.data?.content?.trim()}><WandSparkles size={16} />二次创作</button><button className="primary-button" type="button" onClick={() => { openConfirmation(selected); setSelected(undefined); }} disabled={!quote.data || !projectDirectory}>一键生成项目</button></div></footer></section></div>}
    {remixSource && <ScriptLibraryRemixModal source={remixSource} projectDirectory={projectDirectory} defaultSpec={defaultSpec} onClose={() => setRemixSource(undefined)} onProjectCreated={onReady} />}
    {confirmation && quote.data && <div className="modal-backdrop script-analysis-confirm-backdrop"><section className="script-analysis-confirm-modal"><header><span><Coins size={23} /></span><div><small>SCRIPT LIBRARY</small><h2>确认使用剧本并扣除积分</h2><p>《{confirmation.item.title}》将直接转换为本地项目。</p></div><button onClick={closeConfirmation}><X size={17} /></button></header><div className="script-analysis-confirm-body"><div><span>本次所需积分</span><strong>{creditText(quote.data.credits)} 积分</strong></div><div><span>当前可用积分</span><strong>{balance.data ? `${creditText(balance.data.available)} 积分` : "正在查询…"}</strong></div>{acceptedUsage?.key !== confirmation.key && balance.data && balance.data.available < quote.data.credits ? <div className="insufficient-credit-callout"><div className="error-banner">积分不足，需要 {creditText(quote.data.credits)} 分，当前可用 {creditText(balance.data.available)} 分。</div><ImmediateCreditPurchaseButton onPurchased={() => void balance.refetch()} /></div> : null}{balance.error && <div className="error-banner">{message(balance.error)}</div>}{create.error && <div className="error-banner">{message(create.error)}</div>}</div><footer><button className="secondary-button" disabled={create.isPending} onClick={closeConfirmation}>取消</button><button className="primary-button" disabled={create.isPending || !projectDirectory.trim() || (acceptedUsage?.key !== confirmation.key && (!balance.data || balance.data.available < quote.data.credits))} onClick={() => create.mutate(confirmation)}>{create.isPending ? <><LoaderCircle className="spin" />正在生成…</> : acceptedUsage?.key === confirmation.key ? <>重试创建项目（不会重复扣分）</> : <>确认扣除并生成</>}</button></footer></section></div>}
  </div>;
}

function ScriptLibraryRemixModal({ source, projectDirectory, defaultSpec, onClose, onProjectCreated }: { source: ScriptLibraryRemixSource; projectDirectory: string; defaultSpec: CreationSpec; onClose: () => void; onProjectCreated: (bundle: ProjectBundle) => void }) {
  const sourceKey = `script-library:${source.item.id}`;
  const [projectName, setProjectName] = useState(`${source.item.title.trim().slice(0, 48)}·二创`);
  const [creativeDirection, setCreativeDirection] = useState("保留原剧本的核心主题、价值立场、关注群体和情绪诉求，在同一主题范围内重新设计人物身份、场景、事件与台词；保留有效的冲突升级和反转功能，但不复用原剧情表达。");
  const [originality, setOriginality] = useState<VideoRemixOriginality>("high");
  const [storyboardDurationMode, setStoryboardDurationMode] = useState<VideoRemixStoryboardDurationMode>("fixed");
  const [targetDuration, setTargetDuration] = useState(Math.max(15, Math.min(600, Math.round(source.item.duration_seconds || defaultSpec.target_duration))));
  const [aspectRatio, setAspectRatio] = useState<"9:16" | "16:9">(defaultSpec.aspect_ratio === "16:9" ? "16:9" : "9:16");
  const [visualStyle, setVisualStyle] = useState(defaultSpec.visual_style || "");
  const remixTasks = useQuery({ queryKey: ["video-remix-tasks", sourceKey], queryFn: () => listVideoRemixTasks(sourceKey), refetchInterval: 1_500 });
  const createRemix = useMutation({
    mutationFn: () => createVideoRemixTask({
      source_task_id: sourceKey,
      source_type: "script_library",
      source_text: source.content,
      project_name: projectName.trim(),
      creative_direction: creativeDirection.trim(),
      originality,
      storyboard_duration_mode: storyboardDurationMode,
      target_duration: targetDuration,
      aspect_ratio: aspectRatio,
      visual_style: visualStyle.trim(),
      language: defaultSpec.language || "zh-CN",
    }),
    onSuccess: () => remixTasks.refetch(),
  });
  const retryRemix = useMutation({ mutationFn: retryVideoRemixTask, onSuccess: () => remixTasks.refetch() });
  const deleteRemix = useMutation({ mutationFn: deleteVideoRemixTask, onSuccess: () => remixTasks.refetch() });
  const saveProject = useMutation({
    mutationFn: (task: VideoRemixTask) => createVideoRemixProject({ remix_task_id: task.id, root_path: projectDirectory, project_name: task.result?.title?.trim() || task.project_name }),
    onSuccess: onProjectCreated,
  });
  const canCreate = !createRemix.isPending && projectName.trim().length > 0 && creativeDirection.trim().length >= 4 && targetDuration >= 15 && targetDuration <= 600;
  const activeCount = (remixTasks.data ?? []).filter((task) => task.status === "PENDING" || task.status === "RUNNING").length;
  return <div className="modal-backdrop script-library-remix-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="script-library-remix-modal">
      <header><div><span className="section-label">SCRIPT REMIX</span><h2>《{source.item.title}》二次创作</h2><p>继承核心主题与叙事功能，生成全新剧情、人物关系和分镜。</p></div><button type="button" onClick={onClose}><X size={18} /></button></header>
      <div className="script-library-remix-content">
        <ModelCreditNotice capability="TEXT_GENERATION" action="二创" />
        <div className="video-remix-form">
          <label>新项目名称<input value={projectName} maxLength={80} onChange={(event) => setProjectName(event.target.value)} /></label>
          <label className="video-remix-direction">二创方向<textarea rows={4} value={creativeDirection} onChange={(event) => setCreativeDirection(event.target.value)} placeholder="描述希望保留的主题，以及人物、冲突、场景或结局的改编方向" /><small>默认保留原剧本主题和情绪诉求，重构人物、场景、事件与台词，避免改名式复刻。</small></label>
          <div className="field-grid script-library-remix-fields">
            <label>原创强度<select value={originality} onChange={(event) => setOriginality(event.target.value as VideoRemixOriginality)}><option value="balanced">平衡改编</option><option value="high">高度原创（推荐）</option><option value="radical">激进原创（强冲突多反转）</option></select></label>
            <label>分镜时长<select value={storyboardDurationMode} onChange={(event) => setStoryboardDurationMode(event.target.value as VideoRemixStoryboardDurationMode)}><option value="fixed">固定时长（每镜10秒）</option><option value="adaptive">非固定时长（每镜8～15秒）</option></select></label>
            <label>目标时长<div className="unit-input"><input type="number" min={15} max={600} step={1} value={targetDuration} onChange={(event) => setTargetDuration(Number(event.target.value))} /><span>秒</span></div></label>
            <label>画面比例<select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as "9:16" | "16:9")}><option value="9:16">9:16</option><option value="16:9">16:9</option></select></label>
            <label>画风设定<input value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)} placeholder="留空由 AI 根据剧本生成" /></label>
          </div>
          <div className="video-remix-submit-row"><span>沿用视频解析二创的生成、质量检查、积分确认和失败重试流程。</span><button className="primary-button" type="button" disabled={!canCreate} onClick={() => { createRemix.reset(); createRemix.mutate(); }}>{createRemix.isPending ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{createRemix.isPending ? "正在创建任务…" : "生成全新剧情与分镜（需积分）"}</button></div>
          {createRemix.error && <div className="error-banner">{message(createRemix.error)}</div>}
        </div>
        <section className="script-library-remix-history">
          <header><div><strong>二创记录</strong><small>任务和结果保存在本机，可关闭弹窗后继续运行</small></div><span>{activeCount ? `${activeCount} 个生成中` : `${remixTasks.data?.length ?? 0} 条结果`}</span></header>
          {deleteRemix.error && <div className="error-banner">删除二创记录失败：{message(deleteRemix.error)}</div>}
          {remixTasks.isLoading ? <div className="video-remix-empty"><LoaderCircle className="spin" size={18} />正在读取二创记录…</div> : remixTasks.error ? <div className="error-banner">{message(remixTasks.error)}</div> : (remixTasks.data ?? []).length === 0 ? <div className="video-remix-empty">还没有二创记录，请先生成一版全新剧情与分镜。</div> : <div className="video-remix-task-list">{(remixTasks.data ?? []).map((task) => <ScriptLibraryRemixTaskCard key={task.id} task={task} projectDirectory={projectDirectory} retrying={retryRemix.isPending && retryRemix.variables === task.id} deleting={deleteRemix.isPending && deleteRemix.variables === task.id} saving={saveProject.isPending && saveProject.variables?.id === task.id} saveError={saveProject.variables?.id === task.id ? saveProject.error : undefined} onRetry={() => retryRemix.mutate(task.id)} onDelete={() => { if (window.confirm("确定删除这条二创记录吗？删除后无法恢复。")) deleteRemix.mutate(task.id); }} onSave={() => saveProject.mutate(task)} />)}</div>}
        </section>
      </div>
      <footer><button className="secondary-button" type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}

function ScriptLibraryRemixTaskCard({ task, projectDirectory, retrying, deleting, saving, saveError, onRetry, onDelete, onSave }: { task: VideoRemixTask; projectDirectory: string; retrying: boolean; deleting: boolean; saving: boolean; saveError?: Error | null; onRetry: () => void; onDelete: () => void; onSave: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const active = task.status === "PENDING" || task.status === "RUNNING";
  const shots = task.result?.canonical.shots ?? [];
  return <article className={`video-remix-task ${task.status.toLowerCase()}`}>
    <header><div><span>{active ? <LoaderCircle className="spin" size={16} /> : task.status === "COMPLETED" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}</span><div><strong>{task.result?.title || task.project_name}</strong><small>{task.message} · {task.input.storyboard_duration_mode === "adaptive" ? "非固定8～15秒" : "固定10秒"} · {new Date(task.created_at).toLocaleString("zh-CN")}</small></div></div><div className="video-remix-task-header-actions"><em>{Math.round(task.progress * 100)}%</em>{task.status === "COMPLETED" && task.result && <button className="secondary-button" type="button" disabled={deleting} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "展开"}<ChevronRight className={expanded ? "expanded" : ""} size={15} /></button>}<button className="secondary-button danger-button" type="button" disabled={deleting} onClick={onDelete}>{deleting ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{deleting ? "删除中…" : "删除"}</button></div></header>
    {active && <div className="video-remix-progress"><i style={{ width: `${Math.round(task.progress * 100)}%` }} /></div>}
    {task.status === "FAILED" && <div className="video-remix-failed"><span>{task.error?.message || "二次创作失败"}</span><button className="secondary-button" type="button" disabled={retrying || deleting} onClick={onRetry}>{retrying ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{retrying ? "重新加入队列…" : "重试"}</button></div>}
    {expanded && task.status === "COMPLETED" && task.result && <div className="video-remix-result">
      <div className="video-remix-story"><span>一句话梗概</span><strong>{task.result.logline}</strong><p>{task.result.synopsis}</p></div>
      <details className="video-remix-shots"><summary>查看全部 {shots.length} 个新分镜</summary><div>{shots.map((shot, index) => <article key={shot.id || index}><header><strong>分镜 {index + 1}</strong><span>{shot.duration}秒 · {shot.shot_size} · {shot.camera_movement}</span></header><p><b>画面</b>{shot.visual}</p><p><b>动作</b>{shot.action}</p>{shot.dialogue && shot.dialogue !== "无" && <p><b>台词</b>{shot.dialogue}</p>}</article>)}</div></details>
      {saveError && <div className="error-banner">{message(saveError)}</div>}
      <footer><span>{task.project_path ? `已创建项目：${task.project_path}` : "确认结果后保存为独立本地项目，原剧本库内容不会改变。"}</span><button className="primary-button" type="button" disabled={saving || deleting || !projectDirectory.trim()} title={!projectDirectory.trim() ? "请先在系统设置中配置项目保存目录" : undefined} onClick={onSave}>{saving ? <LoaderCircle className="spin" size={17} /> : <Rocket size={17} />}{saving ? "正在保存新项目…" : task.project_path ? "再次保存为新项目（免费）" : "保存为新项目（免费）"}</button></footer>
    </div>}
  </article>;
}
