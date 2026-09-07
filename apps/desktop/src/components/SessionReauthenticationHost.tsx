import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AccountCenterModal } from "./AccountCenterModal";
import { activatePlatformUserContext } from "../services/platform";

const SESSION_EXPIRED_EVENT = "aivs:session-expired";

function errorText(error: unknown, seen = new Set<object>(), depth = 0): string[] {
  if (error == null || depth > 5) return [];
  if (typeof error === "string") {
    try { return [error, ...errorText(JSON.parse(error), seen, depth + 1)]; }
    catch { return [error]; }
  }
  if (typeof error !== "object" || seen.has(error)) return [String(error)];
  seen.add(error);
  if (error instanceof Error) return [error.message, ...errorText(error.cause, seen, depth + 1)];
  if (Array.isArray(error)) return error.flatMap(value => errorText(value, seen, depth + 1));
  return Object.values(error).flatMap(value => errorText(value, seen, depth + 1));
}

export function isPlatformSessionExpired(error: unknown): boolean {
  const status = error && typeof error === "object" && "status" in error ? Number((error as { status?: unknown }).status) : undefined;
  const text = errorText(error).join("\n");
  return status === 401 || /PLATFORM_LOGIN_REQUIRED|登录(?:状态)?已过期|登录失效|请重新登录后继续查询/i.test(text);
}

export function requestSessionReauthentication(error: unknown): void {
  if (!isPlatformSessionExpired(error)) return;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { message: errorText(error).find(value => /登录/.test(value)) } }));
}

export function SessionReauthenticationHost() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const listener = () => setOpen(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
  }, []);
  if (!open) return null;
  const complete = async () => {
    try {
      await activatePlatformUserContext();
      await queryClient.invalidateQueries();
    } catch (error) {
      console.error("重新登录后的任务恢复失败", error);
    } finally {
      setOpen(false);
    }
  };
  return createPortal(<AccountCenterModal required forceReauthentication onClose={() => undefined} onReauthenticated={() => void complete()} />, document.body);
}
