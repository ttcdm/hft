import type { WatchWindow } from './watchWindow';

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
