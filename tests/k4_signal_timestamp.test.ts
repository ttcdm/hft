import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { riskEngine } from '../server/risk/riskEngine';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { autoSnipeController } from '../server/auto/controller';
import { watchWindow } from '../server/signals/watchWindow';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';
import { solPriceService } from '../server/market/solPriceService';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { setAutoMode, resetAuto, releaseAs } from './fixtures/auto';

/**
 * K4 #7: the signal-age limit (8 s) only means something if the timestamp is the source event's. LIVE never defaults it.
 */
describe('K4 #7: LIVE requires the signal timestamp', () => {
  let coordinator: ExecutionCoordinator;
  let fetchState: ReturnType<typeof vi.spyOn>;
  const base = () => ({
    mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'SIG', name: 'Sig', amountSol: 0.005, source: 'AUTO_SNIPER' as const,
    provenance: 'REAL_ONCHAIN' as const, eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
  });

  beforeEach(() => {
    const kp = Keypair.generate();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    coordinator = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    (coordinator as any).realWalletBalanceSol = 1.0;
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
    fetchState = vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    riskEngine.setKillSwitch(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
  });

  it('no timestamp: rejected before any market read', async () => {
    const res = await coordinator.executeTrade(base());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^MISSING_SIGNAL_TIMESTAMP/);
    expect(fetchState).not.toHaveBeenCalled();
  });

  it('a timestamp in the future, zero or NaN is rejected too', async () => {
    for (const ts of [Date.now() + 60_000, 0, NaN, -5]) {
      const res = await coordinator.executeTrade({ ...base(), signalTimestamp: ts });
      expect(res.error, String(ts)).toMatch(/^MISSING_SIGNAL_TIMESTAMP/);
    }
  });

  it('a real signal time is used: an old one trips the 8 s limit, a fresh one passes this gate', async () => {
    const stale = await coordinator.executeTrade({ ...base(), signalTimestamp: Date.now() - 30_000 });
    expect(stale.error).toMatch(/STALE_SIGNAL/);
    const fresh = await coordinator.executeTrade({ ...base(), signalTimestamp: Date.now() - 500 });
    expect(fresh.error ?? '').not.toMatch(/MISSING_SIGNAL_TIMESTAMP|STALE_SIGNAL/);
  });

  it('PAPER is unchanged: no timestamp is needed', async () => {
    (coordinator as any).executionMode = 'PAPER';
    const res = await coordinator.executeTrade(base());
    expect(res.error ?? '').not.toMatch(/MISSING_SIGNAL_TIMESTAMP/);
  });
});

describe('K4 #7: the auto controller passes the watch-window release time', () => {
  afterEach(async () => {
    await resetAuto();
    vi.restoreAllMocks();
  });

  it('executeSnipe receives signalTimestamp = the release time of the mint', async () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    memecoinAggregator.setConfluenceGating(false);
    const mint = Keypair.generate().publicKey.toBase58();
    const l = new PumpFeedListener();
    const ev = l.parseLogs({ err: null, signature: 'k4', logs: [PumpFeedListener.encodeCreateEventLog({ name: 'K4', symbol: 'K4', uri: '', mint, creator: Keypair.generate().publicKey.toBase58() })] } as any, { slot: 9 })!;
    memecoinAggregator.ingestOnChainCreateEvent(ev).liquidityUsd = 15_000;
    l.destroy();
    releaseAs(mint, 'HOT');
    await setAutoMode('SHADOW');
    const spy = vi.spyOn(memecoinAggregator, 'executeSnipe');
    await autoSnipeController.submitCandidate({ mint, symbol: 'K4', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    const released = watchWindow.getVerdict(mint)!.releasedAt!;
    expect(released).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0].signalTimestamp).toBe(released);
  });
});

describe('K4: every HTTP route that reaches executeTrade supplies the signal time', () => {
  // Found by the localnet end-to-end run: POST /api/execution/trade spread the body and never set signalTimestamp, so every
  // operator trade through it was rejected MISSING_SIGNAL_TIMESTAMP in LIVE. Cheap contract guard; the e2e is the real check.
  it('each executionCoordinator.executeTrade( call in server.ts carries signalTimestamp', () => {
    const src = fs.readFileSync('server.ts', 'utf8');
    const calls = [...src.matchAll(/executionCoordinator\.executeTrade\(\{([\s\S]*?)\}\);/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c[1]).toMatch(/signalTimestamp/);
  });
});
