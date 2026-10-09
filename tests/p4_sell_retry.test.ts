import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  ExecutionCoordinator,
  SELL_SLIPPAGE_LADDER_BPS,
  EXIT_RETRY_BASE_MS,
  EXIT_RETRY_MAX_MS,
  EXIT_FAILURE_ALERT_AFTER,
} from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

/**
 * P4 (critique #4): a failing stop-loss must not bleed fees. Real coordinator and SQLite; the RPC, builder and reconciler are stubbed at their edges.
 * Wallet keys are freshly generated throwaway values.
 */
describe('P4: sell preflight, slippage ladder and retry backoff', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let simulate: ReturnType<typeof vi.fn>;
  let submit: ReturnType<typeof vi.spyOn>;
  let quoteSpy: ReturnType<typeof vi.spyOn>;
  let posId: string;

  const mkPosition = (mode: 'LIVE' | 'PAPER' = 'LIVE') => {
    const id = `p4_${mode}_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'P4', name: 'P4 Coin', tokenDecimals: 6,
      tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001, currentPriceSol: 0.00005, currentValueSol: 0.05,
      costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: mode, entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    return id;
  };

  beforeEach(async () => {
    const kp = Keypair.generate();
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    simulate = vi.fn(async () => ({ context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: 6003 }] }, logs: [] } }));
    (coordinator as any).connection.simulateTransaction = simulate;
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    // The sell math cross-check against the SDK is covered elsewhere; here only the slippage argument matters.
    quoteSpy = vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 1000, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    submit = vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({ success: true, signature: 'sellsig', transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' });
    vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: -0.05, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
    } as any);
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    posId = mkPosition();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    await mockJito.stop();
    mockRpc.clear();
  });

  const lastSlippage = () => (quoteSpy.mock.calls.at(-1)![0] as any).slippageBps;

  it('a sell that fails simulation is never sent, so no fee is paid', async () => {
    const res = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^SELL_SIMULATION_FAILED/);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('slippage widens along the ladder after each failure, caps, and resets after a success', async () => {
    const seen: number[] = [];
    for (let i = 0; i < SELL_SLIPPAGE_LADDER_BPS.length + 2; i++) {
      await coordinator.closePosition(posId, 100, 'STOP_LOSS');
      seen.push(lastSlippage());
    }
    const L = SELL_SLIPPAGE_LADDER_BPS;
    expect(seen).toEqual([L[0], L[1], L[2], L[3], L[3], L[3]]);
    expect(L[0]).toBe(800);
    // the market recovers: simulation passes, the sell lands, the counter resets
    simulate.mockImplementation(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    const ok = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(ok.success).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(coordinator.exitSlippageBps(posId)).toBe(800);
    expect(coordinator.getExitFailureCount(posId)).toBe(0);
  });

  it('if the simulation call itself fails the sell is still sent', async () => {
    simulate.mockImplementation(async () => { throw new Error('rpc down'); });
    const res = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(res.success).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('backoff doubles from the base, caps, and is reported by exitRetryWaitMs', async () => {
    const expected = [3000, 6000, 12000, 24000, 30000, 30000];
    expect(EXIT_RETRY_BASE_MS).toBe(3000);
    expect(EXIT_RETRY_MAX_MS).toBe(30000);
    for (const want of expected) {
      const before = Date.now();
      await coordinator.closePosition(posId, 100, 'STOP_LOSS');
      const wait = coordinator.exitRetryWaitMs(posId, before);
      expect(wait).toBeGreaterThanOrEqual(want);
      expect(wait).toBeLessThanOrEqual(want + 5000); // wall time of the call itself
      // jump past the deadline so the next loop iteration is the "next" attempt
      (coordinator as any).exitFailures.get(posId).nextAttemptAt = 0;
    }
  });

  it('an operator alert is raised once failures reach the threshold and cleared by a success', async () => {
    for (let i = 0; i < EXIT_FAILURE_ALERT_AFTER; i++) await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_FAILING' && a.positionId === posId)).toBe(true);
    simulate.mockImplementation(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_FAILING' && a.positionId === posId)).toBe(false);
  });

  it('rejections that attempt nothing do not count as failures: halted, dust, missing position, paper', async () => {
    coordinator.haltAll('test halt');
    await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    coordinator.clearHalt();
    expect(coordinator.getExitFailureCount(posId)).toBe(0);
    await coordinator.closePosition('does-not-exist', 100, 'STOP_LOSS');
    expect(coordinator.getExitFailureCount('does-not-exist')).toBe(0);
    // a LIVE position whose exit is refused as dust, and one whose exit is already in flight
    const dust = mkPosition();
    workstationDb.savePosition({ ...workstationDb.loadPositions().find((p) => p.id === dust)!, tokenQuantityRaw: '100', currentPriceSol: 1e-7, currentValueSol: 1e-8 } as any);
    const dustRes = await coordinator.closePosition(dust, 50, 'TAKE_PROFIT_1');
    expect(dustRes.error).toBe('DUST_POSITION_EXIT_UNECONOMICAL');
    expect(coordinator.getExitFailureCount(dust)).toBe(0);
    (coordinator as any).inFlightPositionExits.add(posId);
    const busy = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(busy.error).toMatch(/^EXIT_IN_PROGRESS/);
    (coordinator as any).inFlightPositionExits.delete(posId);
    expect(coordinator.getExitFailureCount(posId)).toBe(0);
    const paper = mkPosition('PAPER');
    (coordinator as any).recordExitOutcome(paper, { success: false, error: 'whatever' }, 'PAPER');
    expect(coordinator.getExitFailureCount(paper)).toBe(0);
  });

  describe('auto-exit loop', () => {
    beforeEach(() => {
      vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockResolvedValue(undefined);
    });

    it('does not retry a stop-loss while backing off, and retries once the deadline passes', async () => {
      const closeSpy = vi.spyOn(coordinator, 'closePosition').mockResolvedValue({ success: false, pnlSol: 0, error: 'SELL_SIMULATION_FAILED: x' });
      (coordinator as any).recordExitOutcome(posId, { success: false, error: 'SELL_SIMULATION_FAILED: x' }, 'LIVE');
      await coordinator.evaluateAndProcessExits();
      const callsForPos = () => closeSpy.mock.calls.filter((c) => c[0] === posId).length;
      expect(callsForPos()).toBe(0);
      (coordinator as any).exitFailures.get(posId).nextAttemptAt = Date.now() - 1;
      await coordinator.evaluateAndProcessExits();
      expect(callsForPos()).toBe(1);
    });

    it('a position with no failures is exited on the first tick', async () => {
      const closeSpy = vi.spyOn(coordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: -0.05 });
      await coordinator.evaluateAndProcessExits();
      expect(closeSpy.mock.calls.some((c) => c[0] === posId && c[2] === 'STOP_LOSS')).toBe(true);
    });
  });
});
