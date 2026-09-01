import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Coins, LoaderCircle, X } from "lucide-react";
import { getCreditBalance, getMediaCreditQuote, listMediaModels, type PlatformMediaModel } from "../services/platform";
import { creditText } from "../services/creditCopy";
import { workflowTotal } from "../services/workflowBudget";
import { workflowErrorMessage } from "../services/workflowState";
import { singleOptionValue } from "../services/singleOption";
export { workflowTotal } from "../services/workflowBudget";

export type WorkflowSelection = { model: PlatformMediaModel; resolution: string; creditCost: number; workflowCreditId?: string };
export type PlannedMedia = { key: string; group: "场景图" | "角色图" | "分镜图" | "分镜视频"; seconds?: number };
export type WorkflowBudgetItem = PlannedMedia & { provider_model_id: string; resolution: string; credits: number; capability: string };
export type WorkflowStartChoice = { image: WorkflowSelection; video: WorkflowSelection; items: WorkflowBudgetItem[] };
const defaultServices = {getCreditBalance,getMediaCreditQuote,listMediaModels};

export function WorkflowStartModal({ mode, onModeChange, planned, onCancel, onStart, busy, error, services = defaultServices }: {
  mode: "fast" | "storyboard"; onModeChange: (mode: "fast" | "storyboard") => void; planned: PlannedMedia[];
  onCancel: () => void; onStart: (choice: WorkflowStartChoice) => void; busy: boolean; error?: string;
  services?: typeof defaultServices;
}) {
  const models = useQuery({ queryKey:["workflow-start-models"], queryFn:async()=>({ image:await services.listMediaModels("IMAGE_GENERATION"),video:await services.listMediaModels("VIDEO_GENERATION") }) });
  const balance=useQuery({queryKey:["credit-balance"],queryFn:services.getCreditBalance,refetchInterval:5000});
  const [selectedImageId,setImageId]=useState(""); const [selectedVideoId,setVideoId]=useState("");
  const [selectedImageRes,setImageRes]=useState(""); const [selectedVideoRes,setVideoRes]=useState("");
  const imageId=singleOptionValue(models.data?.image.map(model=>model.id)??[],selectedImageId);
  const videoId=singleOptionValue(models.data?.video.map(model=>model.id)??[],selectedVideoId);
  const image=models.data?.image.find(m=>m.id===imageId); const video=models.data?.video.find(m=>m.id===videoId);
  const imageRes=singleOptionValue(image?.resolution_prices.map(price=>price.resolution)??[],selectedImageRes);
  const videoRes=singleOptionValue(video?.resolution_prices.map(price=>price.resolution)??[],selectedVideoRes);
  const quotes=useQuery({queryKey:["workflow-start-quote",planned,imageId,imageRes,videoId,videoRes],enabled:Boolean(image&&video&&imageRes&&videoRes),retry:false,queryFn:async()=>{
    const cache=new Map<string,ReturnType<typeof getMediaCreditQuote>>();
    return Promise.all(planned.map(async item=>{
      const isVideo=item.group==="分镜视频"; const model=isVideo?video!:image!; const resolution=isVideo?videoRes:imageRes;
      const key=JSON.stringify([model.id,resolution,item.seconds]);
      if(!cache.has(key)) cache.set(key,services.getMediaCreditQuote(model.id,resolution,item.seconds));
      const quote=await cache.get(key)!;
      if(!Number.isFinite(quote.credits)||quote.credits<0) throw new Error("暂时查不到所需积分，请稍后再试。");
      return {...item,provider_model_id:model.id,resolution,credits:quote.credits,capability:isVideo?"VIDEO_GENERATION":"IMAGE_GENERATION"};
    }));
  }});
  const total=quotes.data?workflowTotal(quotes.data):undefined;
  const insufficient=total!==undefined&&balance.data!==undefined&&balance.data.available<total;
  const ready=Boolean(image?.resolution_prices.some(p=>p.resolution===imageRes)&&video?.resolution_prices.some(p=>p.resolution===videoRes)&&!models.isFetching&&quotes.data&&!quotes.isFetching&&!quotes.error&&balance.data&&!balance.error&&!insufficient&&!busy);
  const picker=(kind:"image"|"video")=>{
    const list=models.data?.[kind]??[]; const model=kind==="image"?image:video; const res=kind==="image"?imageRes:videoRes;
    return <section className="workflow-model-choice"><h3>{kind==="image"?"图片生成方案":"视频生成方案"}</h3><label>选择方案<select disabled={busy} value={model?.id??""} onChange={e=>{const m=list.find(v=>v.id===e.target.value);if(kind==="image"){setImageId(e.target.value);setImageRes(m?.resolution_prices[0]?.resolution??"");}else{setVideoId(e.target.value);setVideoRes(m?.resolution_prices[0]?.resolution??"");}}}><option value="">请选择</option>{list.map(m=><option key={m.id} value={m.id}>{m.model_alias}</option>)}</select></label><label>清晰度<select disabled={busy||!model} value={res} onChange={e=>kind==="image"?setImageRes(e.target.value):setVideoRes(e.target.value)}><option value="">请选择</option>{model?.resolution_prices.map(p=><option key={p.resolution} value={p.resolution}>{p.label || p.resolution} · {creditText(p.credit_cost)} 积分/{kind==="image"?"张":"秒"}</option>)}</select></label>{model?.generation_notice && <small>{model.generation_notice}</small>}</section>;
  };
  return createPortal(<div className="modal-backdrop"><section className="auto-project-mode-modal" role="dialog" aria-modal="true" aria-labelledby="auto-project-mode-title"><header><div><h2 id="auto-project-mode-title">一键自动创作</h2><p>选好方案，确认一次，剩下交给我们自动完成。</p></div><button className="modal-close" aria-label="关闭" disabled={busy} onClick={onCancel}><X size={18}/></button></header><div className="auto-project-mode-body"><label>制作方式<select value={mode} disabled={busy} onChange={e=>onModeChange(e.target.value as typeof mode)}><option value="fast">快速制作（不生成分镜图）</option><option value="storyboard">先生成分镜图，再制作视频</option></select></label><div className="workflow-model-grid">{picker("image")}{picker("video")}</div><section className="auto-project-credit-card"><header><strong>本次所需积分</strong><Coins size={20}/></header><div className="auto-project-credit-lines">{(["场景图","角色图","分镜图","分镜视频"] as const).map(group=>{
    const rows=planned.filter(item=>item.group===group); const priced=quotes.data?.filter(item=>item.group===group);
    return <div key={group}><span>{group} · {rows.length}{group==="分镜视频"?` 段 / ${creditText(rows.reduce((s,i)=>s+(i.seconds??0),0))} 秒`:" 张"}</span><strong>{priced?creditText(workflowTotal(priced)):"—"} 积分</strong></div>;
  })}<div><span>完整视频合成</span><strong>免费</strong></div><div className="workflow-credit-total"><strong>合计</strong><strong>{total===undefined?"—":creditText(total)} 积分</strong></div></div><small>已有图片和视频不重复生成、不重复扣分。确认后自动运行，不再弹出积分提醒。失败会自动重试，未成功的积分会退回；已生成的内容不会重复扣分。费用有变化或结果暂时无法确认时，会自动停止并在进度中说明，不额外扣分。</small></section>{quotes.isFetching&&<p><LoaderCircle size={16} className="spin"/>正在计算积分…</p>}{models.error&&<p className="error-banner">暂时无法加载生成方案，请稍后再试。</p>}{quotes.error&&<p className="error-banner">{workflowErrorMessage(quotes.error)}</p>}{balance.error&&<p className="error-banner">暂时查不到剩余积分，请稍后再试。</p>}{insufficient&&<p className="error-banner">积分不够，本次需要 {creditText(total!)} 分，你还有 {creditText(balance.data!.available)} 分。</p>}{error&&<p className="error-banner">{error}</p>}</div><footer><button className="secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="primary-button" disabled={!ready} onClick={()=>onStart({image:{model:image!,resolution:imageRes,creditCost:image!.resolution_prices.find(p=>p.resolution===imageRes)!.credit_cost},video:{model:video!,resolution:videoRes,creditCost:video!.resolution_prices.find(p=>p.resolution===videoRes)!.credit_cost},items:quotes.data!})}>{busy?"正在准备…":`确认并自动创作（${total===undefined?"—":creditText(total)} 积分）`}</button></footer></section></div>,document.body);
}
