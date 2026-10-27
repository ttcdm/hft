import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { AutoSnipeController, autoSnipeController, DEVNET_CONFIRMATION_CODE, SESSION_BUDGETS } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { solPriceService } from '../server/market/solPriceService';
import { riskEngine } from '../server/risk/riskEngine';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';
import { resetAuto, releaseAs } from './fixtures/auto';

/**
 * A31/A71 (round 1 #13): the DEVNET_LIVE session spend reset on every setMode and on restart, so the 0.02 SOL real-SOL session cap could be
 * renewed by setting the mode again. The real controller; executeSnipe answers UNCONFIRMED (a buy that was sent and may land), which the
 * controller counts at its worst case.
 */
function newPool(): string {
  const mint = Keypair.generate().publicKey.toBase58();
  const l = new PumpFeedListener();
  const ev = l.parseLogs({ err: null, signature: 'a31', logs: PumpFeedListener.asPumpInvocation(PumpFeedListener.encodeCreateEventLog({ name: 'A31', symbol: 'A31', uri: '', mint, creator: Keypair.generate().publicKey.toBase58() })) } as any, { slot: 9 })!;
  memecoinAggregator.ingestOnChainCreateEvent(ev).liquidityUsd = 15_000;
  l.destroy();
  releaseAs(mint, 'HOT');
  return mint;
}

describe('A31/A71: the DEVNET_LIVE session spend survives a mode change and a restart', () => {
  beforeEach(() => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    vi.spyOn(executionCoordinator, 'getUnresolvedLiveBuys').mockReturnValue({ mints: [], reservedSol: 0 });
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'UNCONFIRMED: no confirmation before timeout', txHash: '' });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAuto();
    riskEngine.setKillSwitch(false);
    workstationDb.setSetting('auto.liveSession', null);
    workstationDb.setSetting('auto.kill', null);
    vi.unstubAllEnvs();
  });

  const setLive = (c: AutoSnipeController = autoSnipeController) => c.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });

  it('OFF then DEVNET_LIVE again keeps the spend; so does a fresh controller (a restart)', async () => {
    expect((await setLive()).ok).toBe(true);
    const d = await autoSnipeController.submitCandidate({ mint: newPool(), source: 'TEST', amountUsd: 1, provenance: 'REAL_ONCHAIN' });
    expect(d.reason).toMatch(/^UNCONFIRMED/);
    const spent = autoSnipeController.getStatus().session!.spentSol;
    expect(spent).toBeGreaterThan(0);

    await autoSnipeController.setMode('OFF');
    expect((await setLive()).ok).toBe(true);
    expect(autoSnipeController.getStatus().session!.spentSol).toBeCloseTo(spent, 12);

    const restarted = new AutoSnipeController();
    const r = await setLive(restarted);
    expect(r.ok, r.error).toBe(true);
    expect(restarted.getStatus().session!.spentSol).toBeCloseTo(spent, 12);
    await restarted.setMode('OFF');
  });

  it('a session whose budget is used cannot be restarted by setting the mode; it ends when its 4 h are up', async () => {
    expect((await setLive()).ok).toBe(true);
    for (let i = 0; i < 4; i++) await autoSnipeController.submitCandidate({ mint: newPool(), source: 'TEST', amountUsd: 1, provenance: 'REAL_ONCHAIN' });
    await autoSnipeController.setMode('OFF');
    const refused = await setLive();
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/SESSION_BUDGET_USED/);

    const later = Date.now() + SESSION_BUDGETS.maxDurationMs + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const fresh = new AutoSnipeController();
    const ok = await setLive(fresh);
    expect(ok.ok, ok.error).toBe(true);
    expect(fresh.getStatus().session!.spentSol).toBe(0);
    await fresh.setMode('OFF');
  });
});
