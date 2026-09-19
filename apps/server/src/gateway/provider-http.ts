import { Agent } from "undici";

// Leave time for settlement and the API response before the desktop's 15-minute
// request deadline. Media submission retains its existing, separate deadline.
export const textProviderTimeoutMs = 12 * 60_000;
export const defaultProviderTimeoutMs = 30 * 60_000;

export function createProviderDispatcher(timeoutMs: number) {
  // Native fetch has its own Undici defaults, independent of AbortController.
  // Override dispatch options as well as client defaults so bundled Node versions
  // cannot silently put a five-minute headers/body timeout back into this call.
  // This dispatcher is request-local; never change the process-wide dispatcher.
  return new Agent({ connect: { timeout: 30_000 }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs })
    .compose(dispatch => (options, handler) => dispatch({
      ...options, headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
    }, handler));
}
