import { workstationDb } from './db/database';
import { executionCoordinator, MARK_STALE_MS } from './execution/coordinator';
import { riskEngine } from './risk/riskEngine';
import { memecoinAggregator } from './memecoinAggregator';
import { watchWindow } from './signals/watchWindow';
import { ExitEngine } from './exits/exitEngine';
import { solPriceService } from './market/solPriceService';
import { onChainPoolStats } from './market/poolStats';
import { getConfluenceThreshold } from './signals/confluenceThreshold';
import { readyGate } from './signals/watchWindow';
import type { NormalizedPosition } from './core/types';

/**
 * H1: one read model for the home board. Every value comes from a real source (on-chain pools, the watch window,
 * the position table, the wallet). A value that is not known is null and the UI shows "—"; nothing is defaulted.
 */
export const WALLET_RESERVE_SOL = 0.015;

export interface NextExit {
  kind: 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT_1' | 'TAKE_PROFIT_2';
  /** Price (SOL/token) at which it fires. */
  priceSol: number;
}

/** The closest exit trigger below the mark (stop) or above it (take profit), from the ExitEngine's own constants. */
export function nextExitFor(p: Pick<NormalizedPosition, 'entryPriceSol' | 'currentPriceSol' | 'trailingStopSol' | 'exitStage'>): NextExit | null {
  const entry = p.entryPriceSol;
  if (!(entry > 0)) return null;
  const stage = p.exitStage ?? 0;
  const stop: NextExit = { kind: 'STOP_LOSS', priceSol: entry * (1 + ExitEngine.HARD_STOP_LOSS_PCT / 100) };
  const trail = p.trailingStopSol ?? 0;
  const floor: NextExit = trail > stop.priceSol ? { kind: 'TRAILING_STOP', priceSol: trail } : stop;
  const tp: NextExit | null =
    stage === 0 ? { kind: 'TAKE_PROFIT_1', priceSol: entry * (1 + ExitEngine.TP1_TRIGGER_PCT / 100) }
    : stage === 1 ? { kind: 'TAKE_PROFIT_2', priceSol: entry * (1 + ExitEngine.TP2_TRIGGER_PCT / 100) }
    : null;
  const mark = p.currentPriceSol;
  if (!(mark > 0)) return floor;
  if (!tp) return floor;
  // nearest trigger by relative distance
  return Math.abs(Math.log(floor.priceSol / mark)) <= Math.abs(Math.log(tp.priceSol / mark)) ? floor : tp;
}

export function buildBoard(now = Date.now()) {
  const mode = executionCoordinator.getExecutionMode();
  const balance = executionCoordinator.getRealWalletBalanceSol();
  const sol = solPriceService.lastKnownPrice();
  const solReading = solPriceService.getPrice();
  // R6-8: the balance is cached (read at boot, after a trade, on an RPC switch and in the DEVNET_LIVE wallet audit); say how old it is
  const balanceRead = riskEngine.getLastBalanceRead();

  const snap = watchWindow.getSnapshot(now);
  // R6-10: every WS launch carried the fixed text "Just now (WS)". The watch window knows how long it has watched each launch, which
  // starts at the create event; a launch it is not watching has no measured age here.
  const watchedAge = new Map<string, string>();
  // R11-10: a released row's age counts from its release (it used to freeze at "over 121s (released)")
  for (const r of snap.released) watchedAge.set(r.metrics.mint, r.releasedAt ? `released ${Math.round(Math.max(0, now - r.releasedAt) / 1000)}s ago` : 'released');
  for (const w of snap.watching) watchedAge.set(w.metrics.mint, `${Math.round(w.metrics.elapsedMs / 1000)}s`);
  const launchAge = (mint: string, text: string | undefined): string | null => (text && text !== 'Just now (WS)' ? text : watchedAge.get(mint) ?? null);

  const launches = memecoinAggregator
    .getPools()
    .filter((p) => p.id.startsWith('pool-onchain-')) // demo/simulated/callout-derived pools are not launches
    .map((p) => ({
      mint: p.contractAddress,
      symbol: p.symbol,
      name: p.name,
      priceSol: p.priceNative > 0 ? p.priceNative : null,
      priceUsd: sol !== null && p.priceNative > 0 ? p.priceNative * sol : null,
      curveProgressPct: Number.isFinite(p.bondingCurveProgress) ? (p.bondingCurveProgress as number) : null,
      top10HoldersPct: p.top10HoldersPct >= 0 ? p.top10HoldersPct : null,
      creatorHoldingPct: p.devHoldingPct >= 0 ? p.devHoldingPct : null,
      // Q10d: a placeholder is not a fact; unknown goes out as null
      mintRevoked: p.authoritiesVerified === false ? null : p.isMintRevoked,
      freezeRevoked: p.authoritiesVerified === false ? null : p.isFreezeRevoked,
      createdAgo: launchAge(p.contractAddress, p.createdAgo),
      /** R11-11: age of the last feed trade the price and curve figures come from; null when no trade was seen (create-event figures). */
      priceAgeMs: (() => { const at = onChainPoolStats.lastTradeAt(p.contractAddress); return at === null ? null : Math.max(0, now - at); })(),
    }));

  // R11-10: a verdict's reason keeps the threshold in force when it was released; the gate reads the live one. Each released row also
  // carries its score, the live threshold, the READY gate's answer and how old the release is (it can be bought only while younger
  // than the risk engine's signal age limit).
  const threshold = getConfluenceThreshold();
  const signalLimitMs = riskEngine.getLimits().maxSignalAgeMs;
  const watching = [
    ...snap.watching.map((w) => ({ mint: w.metrics.mint, state: 'WATCHING' as const, reason: null as string | null, metrics: w.metrics })),
    ...snap.released.map((r) => ({
      mint: r.metrics.mint, state: r.state, reason: r.reason, metrics: r.metrics,
      score: r.score, threshold, readyGate: r.state === 'READY' ? readyGate(r.metrics) : null,
      releasedAgeMs: r.releasedAt ? Math.max(0, now - r.releasedAt) : null, signalLimitMs,
    })),
  ];

  const holding = workstationDb
    .loadPositions(undefined, 'ACTIVE')
    .map((p) => ({
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      mode: p.executionMode,
      entryPriceSol: p.entryPriceSol > 0 ? p.entryPriceSol : null,
      markPriceSol: p.currentPriceSol > 0 ? p.currentPriceSol : null,
      markAgeMs: p.lastMarkTimestamp ? now - p.lastMarkTimestamp : null,
      /** R6-7: older than the coordinator's MARK_STALE_MS (or never marked) */
      markStale: !p.lastMarkTimestamp || now - p.lastMarkTimestamp > MARK_STALE_MS,
      costSol: p.costBasisLamports ? p.costBasisLamports / 1e9 : null,
      pnlSol: p.currentPriceSol > 0 && !String(p.entryTxSignature || '').startsWith('RECOVERED:') ? (p.realizedPnLSol ?? 0) + (p.unrealizedPnLSol ?? 0) : null,
      nextExit: nextExitFor(p),
    }));

  return {
    generatedAt: now,
    executionMode: mode,
    wallet: {
      balanceSol: balance,
      reserveSol: WALLET_RESERVE_SOL,
      /** Rent of open LIVE positions' token accounts (SPL minimum; a floor for Token-2022). Computed, not read from chain. */
      rentLockedSol: balance === null ? null : executionCoordinator.getRentLockedSol(),
      spendableSol: balance === null ? null : executionCoordinator.getSpendableBankrollSol(),
      solUsd: sol,
      /** R6-7: age of the SOL/USD reading; stale past SOL_PRICE_MAX_AGE_MS (USD figures still use it, LIVE sizing refuses it) */
      solUsdAgeMs: solReading.ageMs,
      solUsdStale: solReading.stale,
      /** R6-8: age of the last successful wallet balance read; null when none succeeded or the last read failed */
      balanceAgeMs: balance !== null && balanceRead?.ok ? now - balanceRead.at : null,
      balanceLastReadFailed: balanceRead ? !balanceRead.ok : false,
    },
    launches,
    watching,
    /** Q6c: how full the watch window is and how many launches it turned away because it was full. */
    watchCapacity: snap.capacity,
    holding,
  };
}
