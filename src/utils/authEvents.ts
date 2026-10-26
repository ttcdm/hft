/**
 * UI-5: pollers that need the operator token (mode banner, auto panel, board) used to wait for their next tick after sign-in, so the banner
 * read MODE UNKNOWN for up to 5 s. Sign-in now announces itself and each poller reads at once.
 */
export const AUTHENTICATED_EVENT = 'apex:authenticated';

export function announceAuthenticated(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AUTHENTICATED_EVENT));
}

export function onAuthenticated(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(AUTHENTICATED_EVENT, fn);
  return () => window.removeEventListener(AUTHENTICATED_EVENT, fn);
}
