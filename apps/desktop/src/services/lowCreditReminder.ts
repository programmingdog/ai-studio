export const LOW_CREDIT_THRESHOLD = 10;
export type LowCreditState = { userId: string | null; notified: boolean; open: boolean };
export const initialLowCreditState: LowCreditState = { userId: null, notified: false, open: false };

export function isLowCredit(available: number | undefined): available is number {
  return available !== undefined && Number.isFinite(available) && available < LOW_CREDIT_THRESHOLD;
}

/** Once per continuous low-balance period and login; recovery to 10 re-arms it. */
export function nextLowCreditState(previous: LowCreditState, userId: string | null, available: number | undefined, blocked: boolean): LowCreditState {
  if (!userId) return initialLowCreditState;
  const state = previous.userId === userId ? previous : { userId, notified: false, open: false };
  if (available === undefined || !Number.isFinite(available)) return { ...state, open: false };
  if (!isLowCredit(available)) return { userId, notified: false, open: false };
  if (blocked) return { ...state, open: false };
  if (!state.notified) return { userId, notified: true, open: true };
  return state;
}
