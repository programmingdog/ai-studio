import {useState} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {WorkflowStartModal,workflowTotal,type PlannedMedia} from "../src/components/WorkflowStartModal";
import type {PlatformMediaModel} from "../src/services/platform";
import "../src/styles.css";
const services={
  listMediaModels:async(capability:PlatformMediaModel["capability"])=>[{id:capability,model_alias:capability==="IMAGE_GENERATION"?"测试图片方案":"测试视频方案",capability,resolution_prices:[{resolution:capability==="IMAGE_GENERATION"?"2K":"720P",credit_cost:capability==="IMAGE_GENERATION"?2:.5}]} as PlatformMediaModel],
  getCreditBalance:async()=>({balance:25,held:0,available:25}),
  getMediaCreditQuote:async(id:string,resolution:string,seconds?:number)=>({provider_model_id:id,model_alias:id,model_code:id,capability:id,credits:id==="IMAGE_GENERATION"?2:(seconds??0)*.5,resolution,seconds:seconds??null,includes_multiplier:true}),
};
function Fixture(){
  const [mode,setMode]=useState<"fast"|"storyboard">("fast"); const [open,setOpen]=useState(false); const [result,setResult]=useState("测试数据，不会实际扣分");
  const planned:PlannedMedia[]=[{key:"image:scene:S1",group:"场景图"},{key:"image:scene:S2",group:"场景图"},{key:"image:character_state:C1",group:"角色图"},{key:"video:shot:SH1",group:"分镜视频",seconds:4},{key:"video:shot:SH2",group:"分镜视频",seconds:5},...(mode==="storyboard"?[{key:"image:shot:SH1",group:"分镜图" as const},{key:"image:shot:SH2",group:"分镜图" as const}]:[])];
  return <main style={{padding:40}}><div className="story-page-layout"><section className="panel story-main story-main-single"><h1>剧情页面布局测试</h1><label>主题<input defaultValue="为农民发声"/></label><label>故事概要<textarea rows={7} defaultValue="这是用于检查右下角按钮和统一积分确认的测试页面。"/></label><label>画风设定<textarea rows={3} defaultValue="现代写实"/></label></section><footer className="story-auto-footer"><button className="primary-button" onClick={()=>setOpen(true)}>一键自动创作</button></footer></div><p role="status">{result}</p>{open&&<WorkflowStartModal mode={mode} onModeChange={setMode} planned={planned} busy={false} services={services} onCancel={()=>setOpen(false)} onStart={choice=>{setResult(`已一次确认 ${workflowTotal(choice.items)} 积分；开始自动运行（测试，不扣分）`);setOpen(false);}}/>}</main>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Fixture/></QueryClientProvider>);
