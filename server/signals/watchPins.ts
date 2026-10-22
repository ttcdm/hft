import type { EventEmitter } from 'events';
import type { WatchWindow, WatchResult } from './watchWindow';
import { CREATOR_REPORT_GRACE_MS } from './creatorRiskScorer';

/** S4: the pool and the trade stats of a mint the watch window is still scoring must outlive the newest-N eviction of both caches. */
export function wireWatchPins(
  window: Pick<WatchWindow, 'isWatching'>,
  aggregator: { setPoolPinned(fn: (mint: string) => boolean): void },
  stats: { setPinned(fn: (mint: string) => boolean): void },
): void {
  const pinned = (mint: string) => window.isWatching(mint);
  aggregator.setPoolPinned(pinned);
  stats.setPinned(pinned);
}

/**
 * P4.1 (R1-53): the creator report of a watched launch is pinned for the watch's life and kept CREATOR_REPORT_GRACE_MS after its release,
 * so a re-score at execution time still finds it. It used to expire 120 s after the create event, before a READY release.
 */
export function wireCreatorReportPins(
  window: Pick<WatchWindow, 'isWatchingCreator'> & Pick<EventEmitter, 'on'>,
  scorer: { setPinned(fn: (creator: string) => boolean): void; holdFor(creator: string, ms: number): void },
): void {
  scorer.setPinned((creator) => window.isWatchingCreator(creator));
  window.on('release', (r: WatchResult) => {
    if (r.metrics.creator) scorer.holdFor(r.metrics.creator, CREATOR_REPORT_GRACE_MS);
  });
}
