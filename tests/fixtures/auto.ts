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
export function newPumpPool() {
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const l = new PumpFeedListener();
  const ev = l.parseLogs({ err: null, signature: 'g3', logs: [PumpFeedListener.encodeCreateEventLog({ name: 'G3', symbol: 'G3', uri: '', mint, creator })] } as any, { slot: 9 })!;
  const pool = memecoinAggregator.ingestOnChainCreateEvent(ev);
  pool.liquidityUsd = 15_000; // a created pool starts at $0, which the liquidity gate (correctly) rejects
  l.destroy();
  return { mint, pool };
}
