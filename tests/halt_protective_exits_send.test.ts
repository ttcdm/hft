import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { txBuilder } from '../server/solana/transactionBuilder';
import { TradeReconciler } from '../server/execution/reconciliation';
import { executionConfig } from '../server/solana/executionConfig';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

/**
 * P1.8 (R1-134): README and the halt alert said a halt stops exits. It does not: after haltAll a LIVE stop-loss still reaches the network,
 * while a take-profit is refused TRADING_HALTED before anything is sent. tests/l8_halt_persists.test.ts covers the reason filter with the
 * close implementation stubbed; this one runs the real LIVE sell path down to the Connection's sendRawTransaction.
 * The wallet key is a freshly generated throwaway value.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});

function signedTx(): VersionedTransaction {
  const payer = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

function haltedLiveCoordinator() {
  // devnet has no block engine: with none configured the RPC transport is the one that sends (the suite env sets a dead mock URL)
  const realConfig = executionConfig.getConfig();
  vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...realConfig, jitoBlockEngineUrl: '' });
  const kp = Keypair.generate();
  const mockRpc = new MockSolanaRpc();
  vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
  vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
  vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
  PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
  PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
  const c = new ExecutionCoordinator(mockRpc.createConnection());
  cleanups.push(() => {
    c.cleanup();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    mockRpc.clear();
  });
  const conn = (c as any).connection;
  const send = vi.spyOn(conn, 'sendRawTransaction');
  vi.spyOn(c.getJitoTransport(), 'getTipFloorLamports').mockResolvedValue(null as any); // the public tip-floor service is a network call
  vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
  vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
  vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
  vi.spyOn(txBuilder, 'buildSellTransaction').mockImplementation(async () => signedTx() as any);
  vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
  vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
    success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
    actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
    actualJitoTipLamports: 0, actualRealizedPnLSol: -0.05, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
  } as any);
  const id = `halt_${Math.random().toString(36).slice(2)}`;
  workstationDb.savePosition({
    id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'HALT', name: 'Halt Coin', tokenDecimals: 6,
    tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001, currentPriceSol: 0.00005, currentValueSol: 0.05,
    costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
    executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
    recordUpdatedAt: Date.now(), updatedAt: Date.now(),
  } as any);
  c.haltAll('unexplained wallet change (test)');
  return { c, id, send };
}

describe('after haltAll, protective exits still send and discretionary exits do not', () => {
  it('a LIVE STOP_LOSS reaches sendRawTransaction and closes the position', async () => {
    const { c, id, send } = haltedLiveCoordinator();
    expect(c.getHaltReason()).not.toBeNull();
    const res = await c.closePosition(id, 100, 'STOP_LOSS');
    expect(res.error ?? '').not.toMatch(/TRADING_HALTED/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(true);
  });

  it('a LIVE TAKE_PROFIT_1 returns TRADING_HALTED and sends nothing', async () => {
    const { c, id, send } = haltedLiveCoordinator();
    const res = await c.closePosition(id, 33, 'TAKE_PROFIT_1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^TRADING_HALTED: unexplained wallet change \(test\)/);
    expect(send).not.toHaveBeenCalled();
  });

  it('the TRADING_HALTED alert says which exits still run, not that exits are halted', () => {
    const { c } = haltedLiveCoordinator();
    const alert = c.getOperatorAlerts().find((a) => a.code === 'TRADING_HALTED' && !a.cleared);
    expect(alert).toBeDefined();
    expect(alert!.message).not.toMatch(/including exits/i);
    expect(alert!.message).toMatch(/Stop-loss, trailing stop, manual close and panic still run/);
  });
});
