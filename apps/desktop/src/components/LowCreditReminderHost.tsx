import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Coins } from "lucide-react";
import { getCreditBalance, getPlatformUser, loadPlatformSession } from "../services/platform";
import { initialLowCreditState, isLowCredit, nextLowCreditState } from "../services/lowCreditReminder";
import { AccountCenterModal } from "./AccountCenterModal";
import { creditText } from "./CreditConfirmationHost";
import { useWorkflowQuiet } from "../services/workflowQuiet";

export function LowCreditReminderDialog({ available, onDismiss, onPurchase }: { available: number; onDismiss: () => void; onPurchase: () => void }) {
  return <div className="modal-backdrop low-credit-backdrop" data-low-credit-reminder>
    <section className="low-credit-modal" role="dialog" aria-modal="true" aria-labelledby="low-credit-title" aria-describedby="low-credit-description">
      <Coins size={32} /><h2 id="low-credit-title">积分即将不足</h2>
      <p id="low-credit-description">你还有 <strong>{creditText(available)} 积分</strong> 可以使用，不到 10 分了。购买积分套餐，就能继续创作。</p>
      <small>点击下方按钮查看套餐，不会自动下单或扣款。</small>
      <footer><button className="secondary-button" autoFocus onClick={onDismiss}>稍后再说</button><button className="primary-button" onClick={onPurchase}>购买积分套餐</button></footer>
    </section>
  </div>;
}

export function LowCreditReminderHost() {
  const workflowQuiet = useWorkflowQuiet();
  const session = useQuery({ queryKey: ["platform-session"], queryFn: loadPlatformSession, staleTime: Infinity });
  const user = useQuery({ queryKey: ["platform-user"], queryFn: getPlatformUser, enabled: Boolean(session.data), retry: false });
  const userId = session.data?.user_id && session.data.user_id === user.data?.id ? user.data.id : null;
  // Account-scoped cache avoids displaying a previous user's balance at login.
  // Payment invalidation of ["credit-balance"] also refreshes this query.
  const balance = useQuery({ queryKey: ["credit-balance", userId], queryFn: getCreditBalance, enabled: Boolean(userId), refetchInterval: userId ? 15_000 : false, retry: false });
  const available = !balance.isError && userId ? balance.data?.available : undefined;
  const [state, setState] = useState(initialLowCreditState);
  const [blocked, setBlocked] = useState(true);
  const [purchaseUserId, setPurchaseUserId] = useState<string | null>(null);
  const low = isLowCredit(available);

  useEffect(() => {
    if (!low) return;
    // Do not cover login, payment, model selection or a fee-confirmation dialog.
    const check = () => setBlocked(Array.from(document.querySelectorAll('.modal-backdrop, [role="dialog"]')).some(node => !node.closest("[data-low-credit-reminder]")));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [low]);
  useEffect(() => { setState(previous => nextLowCreditState(previous, userId, available, blocked || workflowQuiet)); }, [userId, available, blocked, workflowQuiet]);
  useEffect(() => { setPurchaseUserId(null); }, [userId]);
  const dismiss = () => setState(previous => ({ ...previous, open: false }));
  const purchase = () => { dismiss(); setPurchaseUserId(userId); };
  if (!userId || workflowQuiet) return null;
  return <>
    {low && !blocked && !state.open && <button className="low-credit-shortcut" onClick={purchase}><Coins size={17} />可用积分 {creditText(available)} · 购买套餐</button>}
    {low && !blocked && state.userId === userId && state.open && createPortal(<LowCreditReminderDialog available={available} onDismiss={dismiss} onPurchase={purchase} />, document.body)}
    {purchaseUserId === userId && createPortal(<AccountCenterModal initialSection="credits" onClose={() => setPurchaseUserId(null)} />, document.body)}
  </>;
}
