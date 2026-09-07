import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CreditCard, LoaderCircle } from "lucide-react";
import { AccountCenterModal } from "./AccountCenterModal";

const CREDIT_PURCHASE_EVENT = "aivs:purchase-credits";

type CreditPurchaseRequest = {
  id: string;
  resolve: () => void;
  reject: (reason: Error) => void;
};

export function isInsufficientCreditError(error: unknown): boolean {
  let text = "";
  try { text = error instanceof Error ? `${error.message}\n${String(error.cause ?? "")}` : typeof error === "string" ? error : JSON.stringify(error ?? ""); }
  catch { text = String(error ?? ""); }
  return [
    /(?:账户|账号|可用)?余额(?:不足|不够|已用完|已耗尽|为\s*0)/i,
    /(?:积分|点数|额度|配额|算力|金币)(?:不足|不够|已用完|已耗尽|为\s*0)/i,
    /账户欠费|账号欠费|充值后重试/i,
    /insufficient[\s_-]+(?:account[\s_-]+)?(?:balance|credit|credits|funds|quota)/i,
    /(?:balance|credit|credits|quota)[\s_-]+(?:is[\s_-]+)?(?:insufficient|exhausted|depleted)/i,
    /(?:out[\s_-]+of|no)[\s_-]+(?:credit|credits|quota)/i,
  ].some(pattern => pattern.test(text));
}

export function requestCreditPurchase(): Promise<void> {
  return new Promise((resolve, reject) => {
    window.dispatchEvent(new CustomEvent(CREDIT_PURCHASE_EVENT, {
      detail: { id: crypto.randomUUID(), resolve, reject } satisfies CreditPurchaseRequest,
    }));
  });
}

export function ImmediateCreditPurchaseButton({ onPurchased, label = "立即购买积分" }: { onPurchased?: () => void; label?: string }) {
  const [opening, setOpening] = useState(false);
  const purchase = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await requestCreditPurchase();
      onPurchased?.();
    } catch {
      // Closing the purchase center keeps the interrupted dialog and its selections intact.
    } finally {
      setOpening(false);
    }
  };
  return <button className="primary-button immediate-credit-purchase" type="button" disabled={opening} onClick={() => void purchase()}>
    {opening ? <LoaderCircle className="spin" size={16} /> : <CreditCard size={16} />}{opening ? "正在打开购买…" : label}
  </button>;
}

export function CreditPurchaseHost() {
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<CreditPurchaseRequest | undefined>(undefined);
  const requestRef = useRef<CreditPurchaseRequest | undefined>(undefined);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<CreditPurchaseRequest>).detail;
      requestRef.current?.reject(new Error("已切换到新的积分购买请求"));
      requestRef.current = detail;
      setRequest(detail);
    };
    window.addEventListener(CREDIT_PURCHASE_EVENT, listener);
    return () => window.removeEventListener(CREDIT_PURCHASE_EVENT, listener);
  }, []);
  if (!request) return null;
  const close = () => {
    if (requestRef.current !== request) return;
    requestRef.current = undefined;
    setRequest(undefined);
    request.reject(new Error("已关闭积分购买"));
  };
  const complete = async () => {
    if (requestRef.current !== request) return;
    await queryClient.invalidateQueries({ queryKey: ["credit-balance"] });
    await queryClient.refetchQueries({ queryKey: ["credit-balance"], type: "active" });
    requestRef.current = undefined;
    setRequest(undefined);
    request.resolve();
  };
  return createPortal(<AccountCenterModal initialSection="credits" purchaseFlow onClose={close} onCreditsPurchased={() => void complete()} />, document.body);
}
