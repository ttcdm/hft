import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { autoSnipeController, DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { solPriceService } from '../server/market/solPriceService';
import { riskEngine } from '../server/risk/riskEngine';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';
import { resetAuto, releaseAs } from './fixtures/auto';

/**
 * R5-12: auto-kill "sell what it bought" took ownership from BOUGHT rows only, written on a confirmed fill, so an auto buy that returned
 * UNCONFIRMED and was adopted by orphan recovery later stayed open. R6-4: kill answered with a bare count, so refused or failed sells
 * were invisible.
 */
function newPool(): string {
  const mint = Keypair.generate().publicKey.toBase58();
  const l = new PumpFeedListener();
  const ev = l.parseLogs({ err: null, signature: 'r512', logs: PumpFeedListener.asPumpInvocation(PumpFeedListener.encodeCreateEventLog({ name: 'K', symbol: 'K', uri: '', mint, creator: Keypair.generate().publicKey.toBase58() })) } as any, { slot: 9 })!;
  memecoinAggregator.ingestOnChainCreateEvent(ev).liquidityUsd = 15_000;
  l.destroy();
  releaseAs(mint, 'HOT');
  return mint;
}

/** What orphan recovery saves for a landed buy: id and entry signature are the signature (positionFromRecoveredBuy). */
function adoptedPosition(signature: string, mint: string) {
  workstationDb.savePosition({
    id: signature, mint, symbol: 'K', name: 'Recovered', tokenDecimals: 6, tokenQuantityRaw: '1000', costBasisLamports: 5_000_000,
    entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0.005, unrealizedPnLSol: 0, realizedPnLSol: 0, entryTxSignature: signature,
    entryTimestamp: Date.now(), executionMode: 'LIVE', status: 'OPEN', lastUpdatedTimestamp: Date.now(),
  } as any);
}

describe('R5-12 / R6-4: KILL AUTO owns late-landing auto buys and reports every sell it could not make', () => {
  beforeEach(() => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    vi.spyOn(executionCoordinator, 'getUnresolvedLiveBuys').mockReturnValue({ mints: [], reservedSol: 0 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAuto();
    riskEngine.setKillSwitch(false);
    workstationDb.setSetting('auto.kill', null);
    vi.unstubAllEnvs();
  });

  it('an auto buy that returned UNCONFIRMED and was adopted later is sold by kill({exitAll}); a manual position is not', async () => {
    const sig = `unconf-${Math.random().toString(36).slice(2)}`;
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'UNCONFIRMED: no confirmation before timeout', txHash: sig });
    expect((await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE })).ok).toBe(true);
    const mint = newPool();
    const d = await autoSnipeController.submitCandidate({ mint, source: 'TEST', amountUsd: 1, provenance: 'REAL_ONCHAIN' });
    expect(d.outcome).toBe('REJECTED');
    await autoSnipeController.setMode('OFF'); // the session is gone (as after a restart)

    adoptedPosition(sig, mint); // orphan recovery adopts the landed buy
    const manual = `manual-${Math.random().toString(36).slice(2)}`;
    adoptedPosition(manual, Keypair.generate().publicKey.toBase58());

    const close = vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: 0, status: 'CLOSED' });
    const r = await autoSnipeController.kill({ exitAll: true, reason: 'r5-12' });
    expect(close.mock.calls.map((c) => c[0])).toContain(sig);
    expect(close.mock.calls.map((c) => c[0])).not.toContain(manual);
    expect(r.closed).toBe(1);
  });

  it('refused and failed sells are listed, with what is still open', async () => {
    const a = `own-a-${Math.random().toString(36).slice(2)}`;
    const b = `own-b-${Math.random().toString(36).slice(2)}`;
    for (const id of [a, b]) {
      adoptedPosition(id, Keypair.generate().publicKey.toBase58());
      workstationDb.logDecision({ autoMode: 'DEVNET_LIVE', mint: 'm', stage: 'fill', outcome: 'BOUGHT', reason: 'test', positionId: id });
    }
    vi.spyOn(executionCoordinator, 'closePosition').mockImplementation(async (id: string) =>
      id === a ? { success: false, pnlSol: 0, error: 'SELL_SIMULATION_FAILED: x', notSent: true } : { success: false, pnlSol: 0, error: 'SELL_FAILED: y' });
    const r = await autoSnipeController.kill({ exitAll: true, reason: 'r6-4' });
    expect(r.closed).toBe(0);
    expect(r.refused.map((x) => x.positionId)).toContain(a);
    expect(r.failed.map((x) => x.positionId)).toContain(b);
    expect(r.failed.find((x) => x.positionId === b)!.error).toMatch(/SELL_FAILED/);
    expect(r.stillOpen).toBeGreaterThanOrEqual(2);
  });
});
