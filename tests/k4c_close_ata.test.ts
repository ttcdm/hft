import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

/** K4 #9: the token account is closed only when the sell empties it. Real coordinator; RPC, builder and reconciler stubbed at the edges. */
describe('K4 #9: close the token account only if the sell leaves it empty', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let balance: () => Promise<any>;
  let customIxs: any[][];
  let curveCloseFlags: Array<boolean | undefined>;
  const TOTAL = 1_000_000_000n;

  const mkPosition = () => {
    const id = `k4c_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'K4C', name: 'K4C', tokenDecimals: 6, tokenQuantityRaw: TOTAL.toString(),
      entryPriceSol: 0.0001, currentPriceSol: 0.0002, currentValueSol: 0.2, costBasisLamports: 100_000_000, realizedPnLSol: 0,
      status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(),
      lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
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
    const conn = (coordinator as any).connection;
    conn.simulateTransaction = async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } });
    balance = async () => ({ context: { slot: 1 }, value: { amount: TOTAL.toString(), decimals: 6, uiAmount: 1000 } });
    conn.getTokenAccountBalance = () => balance();
    customIxs = [];
    curveCloseFlags = [];
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMPSWAP', poolAddress: Keypair.generate().publicKey } as any);
    vi.spyOn(PumpSwapVenueService, 'buildPumpSwapSellInstructions').mockResolvedValue({ instructions: [] } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 1000, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildCustomVersionedTransaction').mockImplementation((async (_c: any, _p: any, ixs: any[]) => { customIxs.push(ixs); return {} as any; }) as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockImplementation((async (_c: any, params: any, closeAta?: boolean) => { curveCloseFlags.push(closeAta); expect(params.closeAta).toBe(closeAta); return {} as any; }) as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: TOTAL.toString(), tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({ success: true, signature: 'sellsig', transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' });
    vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: TOTAL.toString(), tokensSoldHuman: 1000, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 2e8, actualNetSolProceedsLamports: 2e8, actualNetworkFeeLamports: 5000, actualJitoTipLamports: 0,
      actualRealizedPnLSol: 0.1, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
    } as any);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    await mockJito.stop();
    mockRpc.clear();
  });

  /** SPL Token CloseAccount is instruction 9 of the token program. */
  const hasClose = () => customIxs.flat().some((ix) => ix?.data?.length === 1 && ix.data[0] === 9);

  it('PumpSwap, 100% sell that empties the account: the close instruction is included', async () => {
    const res = await coordinator.closePosition(mkPosition(), 100, 'MANUAL');
    expect(res.success).toBe(true);
    expect(hasClose()).toBe(true);
  });

  it('PumpSwap, wallet holds more than the recorded quantity (dust / airdrop): NO close instruction', async () => {
    balance = async () => ({ context: { slot: 1 }, value: { amount: (TOTAL + 12345n).toString(), decimals: 6, uiAmount: 1 } });
    const res = await coordinator.closePosition(mkPosition(), 100, 'MANUAL');
    expect(res.success).toBe(true);
    expect(customIxs.length).toBe(1);
    expect(hasClose()).toBe(false);
  });

  it('PumpSwap, balance unreadable: NO close instruction (keep the rent rather than risk a revert)', async () => {
    balance = async () => { throw new Error('rpc down'); };
    await coordinator.closePosition(mkPosition(), 100, 'MANUAL');
    expect(customIxs.length).toBe(1);
    expect(hasClose()).toBe(false);
  });

  it('PumpSwap, partial sell: never closes', async () => {
    await coordinator.closePosition(mkPosition(), 50, 'TAKE_PROFIT_1');
    expect(customIxs.length).toBe(1);
    expect(hasClose()).toBe(false);
  });

  it('bonding-curve venue: the same rule decides the closeAta flag', async () => {
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    await coordinator.closePosition(mkPosition(), 100, 'MANUAL');
    balance = async () => ({ context: { slot: 1 }, value: { amount: (TOTAL * 2n).toString(), decimals: 6, uiAmount: 2 } });
    await coordinator.closePosition(mkPosition(), 100, 'MANUAL');
    expect(curveCloseFlags).toEqual([true, false]);
  });
});
