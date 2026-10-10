import { describe, it, expect, vi, afterEach } from 'vitest';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { riskEngine } from '../server/risk/riskEngine';
import { MINT_A, MINT_B } from './fixtures/socialFeeds';
import { solPriceService } from '../server/market/solPriceService';
import { memecoinAggregator } from '../server/memecoinAggregator';

// Holistic paper-mode lifecycles through the real coordinator, ExitEngine and SQLite (no ExitEngine or DB stubs).
const open = (mint: string) => workstationDb.loadPositions().find((p) => p.mint === mint);
const mark = async (mint: string, priceSol: number) => {
  await executionCoordinator.updatePositionMarkPrices({ [mint]: { priceSol, source: 'TEST_FIXTURE' } });
};

async function enter(mint: string, price = 0.0001) {
  const res = await executionCoordinator.executeTrade({
    mint, symbol: 'H1', name: 'H1', amountSol: 0.005, jitoTipSol: 0.0001, source: 'AUTO_SNIPER',
    provenance: 'REAL_ONCHAIN', currentPriceSol: price,
  });
  expect(res.success, res.error).toBe(true);
  return res.positionId!;
}

describe('H1: paper-mode holistic lifecycles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    riskEngine.setKillSwitch(false);
  });

  it('entry -> TP1 -> TP2 -> trailing stop closes the rest, with the database consistent at each step', async () => {
    const id = await enter(MINT_A);
    let p = open(MINT_A)!;
    expect(p.id).toBe(id);
    expect(p.exitStage).toBe(0);
    const qty0 = BigInt(p.tokenQuantityRaw as any);
    expect(qty0 > 0n).toBe(true);

    // +35%: TP1 sells 33% and advances to stage 1
    await mark(MINT_A, 0.000135);
    await executionCoordinator.evaluateAndProcessExits();
    p = open(MINT_A)!;
    expect(p.exitStage).toBe(1);
    const qty1 = BigInt(p.tokenQuantityRaw as any);
    expect(qty1 < qty0).toBe(true);
    expect(p.status).toBe('PARTIALLY_CLOSED');

    // +65%: TP2 sells another 33% and advances to stage 2
    await mark(MINT_A, 0.000165);
    await executionCoordinator.evaluateAndProcessExits();
    p = open(MINT_A)!;
    expect(p.exitStage).toBe(2);
    const qty2 = BigInt(p.tokenQuantityRaw as any);
    expect(qty2 < qty1).toBe(true);
    expect(p.highWaterMarkSol).toBeGreaterThanOrEqual(0.000165);
    const stop = p.trailingStopSol!;
    expect(stop).toBeGreaterThan(0);

    // A pullback below the trailing stop exits the remainder
    await mark(MINT_A, stop * 0.98);
    await executionCoordinator.evaluateAndProcessExits();
    p = open(MINT_A)!;
    expect(p.status).toBe('CLOSED');
    expect(workstationDb.loadPositions(undefined, 'ACTIVE').some((x) => x.mint === MINT_A)).toBe(false);
  });

  it('hard stop at -20% closes the full position', async () => {
    await enter(MINT_B);
    await mark(MINT_B, 0.00007);
    await executionCoordinator.evaluateAndProcessExits();
    expect(open(MINT_B)!.status).toBe('CLOSED');
  });

  it('a stale mark (older than 15s) never triggers an exit', async () => {
    const mint = 'So11111111111111111111111111111111111111112';
    await enter(mint);
    const p = open(mint)!;
    p.currentPriceSol = 0.00001; // -90%, would hard-stop if the mark were fresh
    p.lastMarkTimestamp = Date.now() - 60_000;
    workstationDb.savePosition(p);
    vi.spyOn(executionCoordinator, 'updatePositionMarkPrices').mockResolvedValue(undefined as any);
    await executionCoordinator.evaluateAndProcessExits();
    expect(open(mint)!.status).not.toBe('CLOSED');
  });

  it('a position that stays flat past 30 minutes is exited by the time rule', async () => {
    const mint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    await enter(mint);
    // Advance the clock 31 minutes (the entry timestamp is immutable once stored) and keep the mark fresh.
    const later = Date.now() + 31 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const p = open(mint)!;
    p.currentPriceSol = p.entryPriceSol;
    p.lastMarkTimestamp = later;
    workstationDb.savePosition(p);
    vi.spyOn(executionCoordinator, 'updatePositionMarkPrices').mockResolvedValue(undefined as any);
    await executionCoordinator.evaluateAndProcessExits();
    expect(open(mint)!.status).toBe('CLOSED');
  });

  it('a second entry on an already-open mint is refused (no double position)', async () => {
    const mint = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
    await enter(mint);
    const again = await executionCoordinator.executeTrade({
      mint, symbol: 'H1', name: 'H1', amountSol: 0.005, source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', currentPriceSol: 0.0001,
    });
    expect(again.success).toBe(false);
    expect(workstationDb.loadPositions().filter((x) => x.mint === mint)).toHaveLength(1);
  });

  it('C3: the aggregator converts USD to SOL with the SolPriceService price, not a constant', () => {
    solPriceService.setPrice(290, 'TEST_FIXTURE');
    expect((memecoinAggregator as any).solPriceUsd).toBe(290);
    solPriceService.reset();
    expect((memecoinAggregator as any).solPriceUsd).toBe(0); // 0 = unknown; executeSnipe refuses to size without a price
  });
});
