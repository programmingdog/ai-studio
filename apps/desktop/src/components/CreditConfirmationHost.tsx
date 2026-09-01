import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Coins, LoaderCircle } from "lucide-react";
import { getCreditBalance, getModelCreditQuote, type ModelCreditQuote } from "../services/platform";
import { creditAction, creditNotice, creditRefundCopy, creditRetryCopy, creditText } from "../services/creditCopy";
import { useWorkflowQuiet } from "../services/workflowQuiet";
export { creditText } from "../services/creditCopy";

export type PendingCredit = { id: string; operation: string; quote: ModelCreditQuote };
export function ModelCreditNotice({ capability, action = capability === "VIDEO_UNDERSTANDING" ? "视频解析" : "内容生成" }: { capability: "TEXT_GENERATION" | "VIDEO_UNDERSTANDING"; action?: string }) {
  const quote = useQuery({ queryKey: ["model-credit-quote", capability], queryFn: () => getModelCreditQuote(capability), staleTime: 30_000, retry: false });
  return <p className="credit-operation-notice"><Coins size={16} /><span>{quote.data
    ? creditNotice(action, quote.data.credits)
    : quote.isLoading ? "正在查看需要多少积分…" : "暂时查不到所需积分，请稍后再试。现在不会扣分。"}</span></p>;
}

export function CreditConfirmationHost() {
  const workflowQuiet = useWorkflowQuiet();
  const queryClient = useQueryClient();
  const pending = useQuery({ queryKey: ["pending-credit-confirmations"], queryFn: () => invoke<PendingCredit[]>("list_credit_confirmations"), enabled: "__TAURI_INTERNALS__" in window, refetchInterval: 750, refetchIntervalInBackground: true, retry: false });
  const items = pending.data ?? [];
  const balance = useQuery({ queryKey: ["credit-balance"], queryFn: getCreditBalance, enabled: items.length > 0, refetchInterval: items.length ? 2000 : false, retry: false });
  const submit = useMutation({
    mutationFn: async ({ requests, approved }: { requests: PendingCredit[]; approved: boolean }) => {
      // Capture the exact displayed set; newly queued requests need a new confirmation.
      for (const item of requests) await invoke("resolve_credit_confirmation", { id: item.id, approved });
    },
    onSettled: async () => { await pending.refetch(); void queryClient.invalidateQueries({ queryKey: ["credit-balance"] }); void queryClient.invalidateQueries({ queryKey: ["platform-user"] }); },
  });
  if (!items.length || workflowQuiet) return null;
  return createPortal(<CreditConfirmationDialog items={items} available={balance.data?.available} balanceError={Boolean(balance.error)} busy={submit.isPending} submitError={submit.error ? String(submit.error) : undefined} onDecision={approved => submit.mutate({ requests: [...items], approved })} />, document.body);
}

// Pure view: test consent states without a session or any paid provider request.
export function CreditConfirmationDialog({ items, available, balanceError = false, busy = false, submitError, onDecision }: {
  items: PendingCredit[]; available?: number; balanceError?: boolean; busy?: boolean; submitError?: string; onDecision: (approved: boolean) => void;
}) {
  const total = Math.round(items.reduce((sum, item) => sum + item.quote.credits, 0) * 1_000_000) / 1_000_000;
  const insufficient = available !== undefined && available < total;
  const action = items.length === 1 && items[0] ? creditAction(items[0].operation, items[0].quote.capability) : "生成";
  return <div className="modal-backdrop credit-confirmation-backdrop"><section className="credit-confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="credit-confirmation-title">
    <header><Coins size={26} /><div><span className="eyebrow">开始前确认</span><h2 id="credit-confirmation-title">{total === 0 ? "本次免费，不扣积分" : `本次${action}需要扣 ${creditText(total)} 积分`}</h2><p>确认后开始，取消不扣分。</p></div></header>
    {(items.length > 1 || items[0]?.quote.resolution || items[0]?.quote.seconds) && <div className="credit-confirmation-items">{items.map(item => <article key={item.id}><div><strong>{creditAction(item.operation, item.quote.capability)}</strong>{(item.quote.resolution || item.quote.seconds) && <span>{[item.quote.resolution, item.quote.seconds ? `${item.quote.seconds} 秒` : null].filter(Boolean).join(" · ")}</span>}</div><b>{creditText(item.quote.credits)} 积分</b></article>)}</div>}
    <div className="credit-confirmation-summary">{items.length > 1 && <strong>本次共 {items.length} 项，合计 {creditText(total)} 积分</strong>}<span>剩余可用积分：{available !== undefined ? `${creditText(available)} 分` : "正在查看积分…"}</span>{total > 0 && <p>{creditRefundCopy}</p>}<p>{creditRetryCopy}</p>{insufficient && <div className="error-banner">积分不够了，请先购买积分套餐。</div>}{balanceError && <div className="error-banner">暂时查不到剩余积分，请稍后再试。</div>}{submitError && <div className="error-banner">操作未完成，请稍后再试。</div>}</div>
    <footer><button className="secondary-button" disabled={busy} onClick={() => onDecision(false)}>取消，不扣分</button><button className="primary-button" disabled={busy || available === undefined || balanceError || insufficient} onClick={() => onDecision(true)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Coins size={16} />}{total === 0 ? "免费开始" : `确认并开始（${creditText(total)} 积分）`}</button></footer>
  </section></div>;
}
