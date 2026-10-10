import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { pumpFeedListener, PumpCreateEvent, PumpTradeEvent } from '../server/solana/pumpFeedListener';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { watchWindow } from '../server/signals/watchWindow';
import { autoSnipeController } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { onChainPoolStats } from '../server/market/poolStats';
import { curveVelocityEvaluator } from '../server/signals/curveVelocityEvaluator';
import { solPriceService } from '../server/market/solPriceService';
import { workstationDb } from '../server/db/database';
import { setAutoMode, resetAuto } from './fixtures/auto';

/**
 * Q6 end to end, with nothing about the score faked: a create event and a stream of decoded TradeEvents go through the real
 * feed listener, aggregator pool, watch window and auto controller. A token that really is being bought gets a PAPER position.
 */
describe('Q6: a genuinely hot token gets through the whole auto pipeline', () => {
  beforeAll(() => {
    watchWindow.setScoreFn((m) => memecoinAggregator.evaluateTokenConfluence(m).score);
    watchWindow.attach(pumpFeedListener);
    autoSnipeController.attachWatchWindow();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    autoSnipeController.detachWatchWindow();
    onChainPoolStats.clear();
    curveVelocityEvaluator.clear();
    await resetAuto();
  });

  it('70 distinct buyers over a minute: the pool scores at least 70, the window releases HOT, auto opens a PAPER position', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    vi.spyOn(solPriceService, 'lastKnownPrice').mockReturnValue(150);
    const T0 = Date.now();
    await setAutoMode('PAPER');
    autoSnipeController.attachWatchWindow();

    const mint = Keypair.generate().publicKey.toBase58();
    const creator = Keypair.generate().publicKey.toBase58();
    const K = 30_000_000_000n * 1_073_000_000_000_000n;
    let vSol = 30_000_000_000n;
    let vTok = 1_073_000_000_000_000n;
    let realSol = 0n;
    const create: PumpCreateEvent = {
      signature: 'create', slot: 1, mint, creator, user: creator, bondingCurve: Keypair.generate().publicKey.toBase58(), name: 'Hot', symbol: 'HOT', uri: '',
      virtualTokenReserves: vTok, virtualSolReserves: vSol, realTokenReserves: 793_100_000_000_000n, realSolReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n,
      initialPriceSol: Number(vSol) / Number(vTok) / 1000, initialMarketCapSol: 28, receivedAt: T0, parsedAt: T0, parseLatencyMs: 0, source: 'TEST_FEED',
    };
    pumpFeedListener.emit('create_event', create);
    const buy = (i: number, sol: number) => {
      const lam = BigInt(Math.round(sol * 1e9));
      const newSol = vSol + lam;
      const newTok = K / newSol;
      const tokens = vTok - newTok;
      vSol = newSol; vTok = newTok; realSol += lam;
      const t: PumpTradeEvent = {
        signature: `t${i}`, slot: 2 + i, mint, solAmountLamports: lam, tokenAmount: tokens, isBuy: true, user: Keypair.generate().publicKey.toBase58(),
        timestampSec: 0, virtualSolReserves: vSol, virtualTokenReserves: vTok, realSolReserves: realSol, realTokenReserves: 793_100_000_000_000n - tokens,
      };
      pumpFeedListener.ingestTradeEvent(t);
    };
    for (let i = 0; i < 70; i++) {
      vi.setSystemTime(T0 + i * 1000);
      buy(i, 0.2 + i * 0.01); // more SOL per second as it goes: inflow is rising
      if (i >= 20 && i % 2 === 0) watchWindow.tick(Date.now());
      if (watchWindow.getVerdict(mint)?.state === 'HOT') break; // stop the clock at the release: the candidate is submitted from it
    }

    const pool = memecoinAggregator.getPools().find((p) => p.contractAddress === mint)!;
    const scored = memecoinAggregator.evaluateTokenConfluence(pool);
    expect(scored.score, scored.breakdown.explanation).toBeGreaterThanOrEqual(70);
    const verdict = watchWindow.getVerdict(mint);
    expect(verdict?.state, verdict?.reason).toBe('HOT');
    await vi.waitFor(() => expect(workstationDb.loadDecisions({ mint }).some((r) => r.outcome === 'BOUGHT' || r.outcome === 'REJECTED')).toBe(true));
    const rows = workstationDb.loadDecisions({ mint });
    const bought = rows.find((r) => r.outcome === 'BOUGHT');
    expect(bought, JSON.stringify(rows.map((r) => [r.stage, r.outcome, r.reason]))).toBeTruthy();
    expect(executionCoordinator.getPositions('PAPER', 'ACTIVE').some((p) => p.mint === mint)).toBe(true);
  });
});
