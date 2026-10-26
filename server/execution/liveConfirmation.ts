/**
 * Q10b: a one-click trade route (a social signal, a hot callout) used to send a real transaction the moment LIVE was armed, with no
 * mode label or confirmation on the page. While LIVE is armed these routes now need `confirmLive: true` in the body, which the UI sends
 * only after the operator confirmed a dialog that names the cluster. Returns the refusal, or null when the click may proceed.
 */
export function liveConfirmationRefusal(liveArmed: boolean, cluster: string, body: { confirmLive?: unknown } | undefined): string | null {
  if (!liveArmed) return null;
  if (body?.confirmLive === true) return null;
  return `LIVE_CONFIRMATION_REQUIRED: LIVE is armed on ${cluster}, so this click sends a real transaction. Confirm it in the UI (the request must carry confirmLive: true).`;
}
