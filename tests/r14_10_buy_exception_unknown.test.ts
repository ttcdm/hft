import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';
import { riskEngine } from '../server/risk/riskEngine';

/**
 * R14-10: a LIVE buy that throws once its send has begun, when the exception path cannot read the ledger to find the PENDING row, returned
 * CHAIN_ERROR: a clean failure, so auto counted no spend and no late-buy sell or orphan recovery was set up, although the buy may have landed.
 * It is now reported UNCONFIRMED (RECONCILIATION_REQUIRED), as a buy whose row was found. Real ExecutionCoordinator.executeTrade and SQLite;
 * the curve read, the snapshot, the send (which throws) and the unreadable ledger read are the stubbed edges.
 */
describe('R14-10: a LIVE buy exception after the send began, with the ledger unreadable, is unknown, not a clean failure', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let submit: ReturnType<typeof vi.spyOn>;
  let orphan: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    const kp = Keypair.generate();
    rpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => {
      tx.signatures = [Uint8Array.from({ length: 64 }, (_v, i) => (i * 7 + 3) % 256)]; // a signature, as signing gives the tx
      return tx;
    });
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(rpc.createConnection());
    await initDone;
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async () => ({ ...createSimulatedBondingCurveState(), marketDataTimestamp: Date.now() }) as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    submit = vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockRejectedValue(new Error('socket hang up after the PENDING row'));
    orphan = vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    vi.spyOn(coordinator as any, 'liveBuyReadinessProblems').mockReturnValue([]);
    vi.spyOn(riskEngine, 'recordTradeFailure').mockImplementation(() => undefined); // no 15 s failure cool-down left for the next test or file
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0, currentValueSol: 0, currentPriceSol: p.entryPriceSol, realizedPnLSol: 0 } as any);
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    vi.spyOn(workstationDb, 'loadMintExits').mockReturnValue({ lastExit: null, loss: null });
    (coordinator as any).realWalletBalanceSol = 1;
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    rpc.clear();
    settleLeftoverLiveBuys();
  });

  const buy = () => coordinator.executeTrade({
    signalTimestamp: Date.now(), mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'R1410', name: 'R1410', amountSol: 0.005,
    source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
  } as any);
  /** The exception path's ledger read fails: loadTransactions answers [] on an error, loadTransactionsInStates null. */
  const ledgerUnreadable = () => {
    vi.spyOn(workstationDb, 'loadTransactions').mockReturnValue([]);
    vi.spyOn(workstationDb, 'loadTransactionsInStates').mockReturnValue(null);
  };

  it('the send threw and the ledger cannot be read: UNCONFIRMED (RECONCILIATION_REQUIRED) with its signature, and orphan recovery is scheduled', async () => {
    const lateBuys = (coordinator as any).lateBuyWatch as Map<string, number>;
    lateBuys.clear();
    submit.mockImplementation(async () => { ledgerUnreadable(); throw new Error('socket hang up after the PENDING row'); }); // the ledger fails from the send on
    const res = await buy();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(false);
    expect(res.lifecycleState).toBe('RECONCILIATION_REQUIRED'); // was CHAIN_ERROR
    expect(res.error).toMatch(/^UNCONFIRMED: /); // the prefix auto counts as spend that may have landed
    expect(res.txSignature).toBeTruthy();
    expect(lateBuys.has(res.txSignature!)).toBe(true); // a panic or kill after the gate sells it once recovery adopts it
    expect(orphan).toHaveBeenCalled();
  });

  it('a throw before the send began, with the ledger unreadable, is still a plain failure (nothing was sent)', async () => {
    vi.spyOn(txBuilder, 'buildBuyTransaction').mockImplementation(async () => { ledgerUnreadable(); throw new Error('build failed'); });
    const res = await buy();
    expect(submit).not.toHaveBeenCalled();
    expect(res.lifecycleState, res.error).toBe('CHAIN_ERROR');
    expect(res.error).toBe('build failed');
  });
});
