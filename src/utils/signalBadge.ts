/** Q39/Q38: a signal is "LIVE" only when it came from a real feed. Demo and synthetic signals say so. */
export interface BadgeSignal { isLiveFeed?: boolean; provenance?: string }

export function signalFeedBadge(sig: BadgeSignal): 'LIVE' | 'SYNTHETIC' | null {
  const p = sig.provenance ?? '';
  if (p.startsWith('SYNTHETIC') || p === 'DEMO_PAPER') return 'SYNTHETIC';
  return sig.isLiveFeed ? 'LIVE' : null;
}
