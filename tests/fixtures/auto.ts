import { vi } from 'vitest';
import { autoSnipeController, AutoMode } from '../../server/auto/controller';

/** Put the real auto-snipe controller into a mode for a test (the env flag is a controller input). */
export async function setAutoMode(mode: AutoMode): Promise<void> {
  vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
  const r = await autoSnipeController.setMode(mode);
  if (!r.ok) throw new Error(`test setup: could not set auto mode ${mode}: ${r.error}`);
}

export async function resetAuto(): Promise<void> {
  await autoSnipeController.setMode('OFF');
}

import { Keypair } from '@solana/web3.js';
import { memecoinAggregator } from '../../server/memecoinAggregator';
import { PumpFeedListener } from '../../server/solana/pumpFeedListener';

/** A real pool for a fresh mint, created the way the feed creates one. */
export function newPumpPool(verdict: 'HOT' | 'READY' | 'DEAD' | 'NONE' = 'HOT') {
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const l = new PumpFeedListener();
  const ev = l.parseLogs({ err: null, signature: 'g3', logs: PumpFeedListener.asPumpInvocation(PumpFeedListener.encodeCreateEventLog({ name: 'G3', symbol: 'G3', uri: '', mint, creator })) } as any, { slot: 9 })!;
  const pool = memecoinAggregator.ingestOnChainCreateEvent(ev);
  pool.liquidityUsd = 15_000; // a created pool starts at $0, which the liquidity gate (correctly) rejects
  l.destroy();
  if (verdict !== 'NONE') releaseAs(mint, verdict, creator);
  return { mint, pool };
}

import { watchWindow } from '../../server/signals/watchWindow';
import { replay, buyers, wallet as walletFx } from './watch';

const hotMints = new Set<string>();
watchWindow.setScoreFn((m) => (hotMints.has(m) ? 80 : null));

/**
 * G2b: auto candidates must come out of the watch window. Drive the REAL window with replayed trades so the mint
 * is released HOT (30 de-clustered buyers, rising velocity, score 80), READY (window elapsed, no score) or DEAD (creator sold).
 */
export function releaseAs(mint: string, verdict: 'HOT' | 'READY' | 'DEAD', creator: string = walletFx()): void {
  // The release happens "now": LIVE/PAPER risk checks the signal's age, and the release is the signal behind an auto buy.
  const start = Date.now() - (verdict === 'HOT' ? 28_000 : verdict === 'READY' ? 120_000 : 6_000);
  watchWindow.watch(mint, creator, start);
  if (verdict === 'HOT') {
    hotMints.add(mint);
    const b = buyers(30, 25);
    b.wallets.forEach((w, i) => watchWindow.setFunder(w, `fx-funder-${mint.slice(0, 6)}-${i}`));
    for (const { trade, at } of replay(mint, start, [...b.steps, [26, walletFx(), 'sell', 0.05], [27, walletFx(), 'sell', 0.05]])) watchWindow.onTrade(trade, at);
    watchWindow.evaluate(mint, start + 28_000);
  } else if (verdict === 'READY') {
    for (const { trade, at } of replay(mint, start, [[0, walletFx(), 'buy', 0.3], [10, walletFx(), 'buy', 0.2]])) watchWindow.onTrade(trade, at);
    watchWindow.evaluate(mint, start + 120_000);
  } else {
    for (const { trade, at } of replay(mint, start, [[0, walletFx(), 'buy', 0.3], [5, creator, 'sell', 0.01]])) watchWindow.onTrade(trade, at);
  }
}

/** G2b: release every callout token currently held by a pumpfunService as HOT, so the controller reaches the gates under test. */
export function releaseHotCallouts(service: unknown): void {
  for (const c of (service as any).hotCallouts ?? []) {
    if (!watchWindow.getVerdict(c.token.mint)) releaseAs(c.token.mint, 'HOT');
  }
}
