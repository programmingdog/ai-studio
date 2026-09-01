import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, ChevronRight, CirclePlus, LoaderCircle, MessageSquareText, Send, Sparkles, UserRound, X } from "lucide-react";
import type { AgentClientAction } from "@aivs/schemas";
import { listAgentMessages, listAgentRuns, listAgentSessions, sendAgentMessage } from "../services/backend";

function readableError(error: unknown): string {
  const value = String(error ?? "发生未知错误");
  try { return (JSON.parse(value) as { message?: string }).message || value; } catch { return value; }
}

import { ModelCreditNotice } from "./CreditConfirmationHost";

const quickPrompts = [
  "解析这个视频链接，按标准模式创建项目，然后用快速模式自动完成全部制作：",
  "解析这个视频链接，按固定10秒生成分镜，并用分镜图模式完成制作：",
  "请先告诉我从链接视频到成片会经过哪些步骤，不要立即执行。",
];

export function AgentChatModal({ onClose, onProjectAction }: { onClose: () => void; onProjectAction: (action: AgentClientAction) => Promise<void> }) {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [actionError, setActionError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessions = useQuery({ queryKey: ["agent-sessions"], queryFn: listAgentSessions });
  const messages = useQuery({ queryKey: ["agent-messages", sessionId], queryFn: () => listAgentMessages(sessionId!), enabled: Boolean(sessionId), refetchInterval: 2000 });
  const runs = useQuery({ queryKey: ["agent-runs", sessionId], queryFn: () => listAgentRuns(sessionId!), enabled: Boolean(sessionId), refetchInterval: 1500 });
  useEffect(() => {
    if (!sessionId && sessions.data?.[0]) setSessionId(sessions.data[0].id);
  }, [sessionId, sessions.data]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.data, runs.data]);
  const send = useMutation({
    mutationFn: (message: string) => sendAgentMessage(sessionId, message),
    onSuccess: async (result) => {
      setSessionId(result.session.id);
      setDraft("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["agent-messages", result.session.id] }),
        queryClient.invalidateQueries({ queryKey: ["agent-runs", result.session.id] }),
      ]);
      if (result.action) {
        setActionError("");
        try { await onProjectAction(result.action); } catch (error) { setActionError(readableError(error)); }
      }
    },
  });
  const submit = () => {
    const message = draft.trim();
    if (message && !send.isPending) send.mutate(message);
  };
  const activeRun = runs.data?.find((item) => item.status === "RUNNING");
  return <div className="modal-backdrop agent-chat-backdrop">
    <section className="agent-chat-modal" role="dialog" aria-modal="true" aria-labelledby="agent-chat-title">
      <aside className="agent-chat-sessions">
        <div className="agent-chat-brand"><span><Bot size={19} /></span><div><strong>制作 Agent</strong><small>服务端默认文本大模型</small></div></div>
        <button className="agent-new-chat" type="button" onClick={() => { setSessionId(undefined); setDraft(""); }}><CirclePlus size={16} />新对话</button>
        <div className="agent-session-list">{sessions.data?.map((session) => <button className={session.id === sessionId ? "active" : ""} key={session.id} onClick={() => setSessionId(session.id)}><MessageSquareText size={15} /><span><strong>{session.title}</strong><small>{new Date(session.updated_at).toLocaleString("zh-CN", { hour12: false })}</small></span><ChevronRight size={14} /></button>)}</div>
      </aside>
      <main className="agent-chat-main">
        <header><div><span className="eyebrow">AI PRODUCTION AGENT</span><h2 id="agent-chat-title">与制作智能体对话</h2><p>解析视频链接、生成分镜、创建项目，并接续场景图、角色图、分镜图和视频自动制作。</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="agent-chat-body">
          <ModelCreditNotice capability="TEXT_GENERATION" action="助手处理" />
          {!messages.data?.length && !send.isPending ? <section className="agent-chat-empty"><div><Sparkles size={30} /></div><h3>告诉我你想制作什么</h3><p>可以直接粘贴视频分享文案，并说明分镜模式、制作模式和分辨率。执行前请确认内容与平台使用权限。</p><div>{quickPrompts.map((prompt) => <button key={prompt} onClick={() => setDraft(prompt)}>{prompt}</button>)}</div></section> : messages.data?.map((message) => <article className={`agent-message ${message.role}`} key={message.id}><span>{message.role === "user" ? <UserRound size={16} /> : <Bot size={16} />}</span><div><strong>{message.role === "user" ? "你" : "制作 Agent"}</strong><p>{message.content}</p><time>{new Date(message.created_at).toLocaleTimeString("zh-CN", { hour12: false })}</time></div></article>)}
          {send.isPending && <article className="agent-message assistant pending"><span><Bot size={16} /></span><div><strong>制作 Agent</strong><p><LoaderCircle className="spin" size={15} />正在规划并调用工具，请勿重复提交…</p>{activeRun && <div className="agent-run-progress"><i><b style={{ width: `${activeRun.progress * 100}%` }} /></i><small>{activeRun.stage} · {Math.round(activeRun.progress * 100)}%</small></div>}</div></article>}
          {(send.error || actionError) && <div className="error-banner">{actionError || readableError(send.error)}</div>}
          {runs.data?.[0]?.status === "COMPLETED" && !send.isPending && <div className="agent-run-finished"><CheckCircle2 size={14} />最近一次 Agent 运行已完成，模型：{runs.data[0].model}</div>}
          <div ref={bottomRef} />
        </div>
        <footer className="agent-composer"><textarea rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="粘贴视频分享链接，或描述要执行的制作任务…" /><div><span>Enter 发送 · Shift+Enter 换行</span><button className="primary-button" type="button" disabled={!draft.trim() || send.isPending} onClick={submit}>{send.isPending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}发送</button></div></footer>
      </main>
    </section>
  </div>;
}
