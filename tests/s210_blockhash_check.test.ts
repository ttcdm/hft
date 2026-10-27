import { describe, it, expect, vi, afterEach } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { blockhashCheckEnabled, verifyBlockhashIndependently, SELL_BLOCKHASH_RECHECK_DELAYS_MS } from '../server/solana/clusterGuard';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { txBuilder } from '../server/solana/transactionBuilder';
import { TradeReconciler } from '../server/execution/reconciliation';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

const noSleep = async () => undefined;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('S210: the independent blockhash check (pure)', () => {
  it('is off by default and only the exact text true turns it on', async () => {
    expect(blockhashCheckEnabled({})).toBe(false);
    expect(blockhashCheckEnabled({ APEX_VERIFY_BLOCKHASH: '1' })).toBe(false);
    expect(blockhashCheckEnabled({ APEX_VERIFY_BLOCKHASH: 'true' })).toBe(true);
    const isValid = vi.fn(async () => false);
    expect(await verifyBlockhashIndependently('bh', {}, { isValid })).toMatchObject({ ok: true });
    expect(isValid).not.toHaveBeenCalled(); // off: no network call at all
  });

  it('on: a known blockhash passes, an unknown one is refused after one retry, a failed lookup is not definite', async () => {
    const env = { APEX_VERIFY_BLOCKHASH: 'true' } as NodeJS.ProcessEnv;
    const yes = vi.fn(async () => true);
    expect(await verifyBlockhashIndependently('bh', env, { isValid: yes, sleep: noSleep })).toEqual({ ok: true });
    const no = vi.fn(async () => false);
    const v = await verifyBlockhashIndependently('bh', env, { isValid: no, sleep: noSleep });
    expect(v).toMatchObject({ ok: false, definite: true });
    expect(no).toHaveBeenCalledTimes(2);
    const lagging = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await verifyBlockhashIndependently('bh', env, { isValid: lagging, sleep: noSleep })).toEqual({ ok: true });
    const down = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    expect(await verifyBlockhashIndependently('bh', env, { isValid: down, sleep: noSleep })).toMatchObject({ ok: false, definite: false });
  });

  it('is skipped on localnet', async () => {
    const isValid = vi.fn(async () => false);
    const v = await verifyBlockhashIndependently('bh', { APEX_VERIFY_BLOCKHASH: 'true', ALLOWED_CLUSTER: 'localnet' } as any, { isValid });
    expect(v).toMatchObject({ ok: true });
    expect(isValid).not.toHaveBeenCalled();
  });
});

describe('S210: a LIVE sell with the check on', () => {
  async function setup(blockhash: string) {
    vi.stubEnv('APEX_VERIFY_BLOCKHASH', 'true');
    const kp = Keypair.generate();
    const mockRpc = new MockSolanaRpc();
    const sign = vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
    PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
    const c = new ExecutionCoordinator(mockRpc.createConnection());
    const conn = (c as any).connection;
    conn.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } }));
    vi.spyOn(c.getJitoTransport(), 'getTipFloorLamports').mockResolvedValue(null as any);
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({ message: { recentBlockhash: blockhash } } as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(c, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    const id = `s210_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'S210', name: 'S210', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001,
      currentPriceSol: 0.00005, currentValueSol: 0.05, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    return { c, id, sign, mockRpc };
  }
  const cleanup = (c: ExecutionCoordinator, mockRpc: MockSolanaRpc) => { c.cleanup(); PumpCurveService.cachedGlobal = null; PumpCurveService.cachedFeeConfig = null; mockRpc.clear(); };

  it('an unknown blockhash refuses the sell before it is signed', async () => {
    const { c, id, sign, mockRpc } = await setup('UnknownBlockhash11111111111111111111111111111');
    // the independent RPC answers "never heard of it"; no network is used
    const ask = vi.spyOn(Connection.prototype, 'isBlockhashValid').mockResolvedValue({ context: { slot: 1 }, value: false } as any);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const pending = c.closePosition(id, 100, 'STOP_LOSS');
      await vi.advanceTimersByTimeAsync(SELL_BLOCKHASH_RECHECK_DELAYS_MS.reduce((a, b) => a + b, 0) + 100); // R3-6: a SELL re-checks for 6.5 s
      const res = await pending;
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/CLUSTER_GUARD/);
      expect(ask).toHaveBeenCalledTimes(SELL_BLOCKHASH_RECHECK_DELAYS_MS.length + 1);
      expect(sign).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); cleanup(c, mockRpc); }
  });

  it('an unreachable independent RPC does not block a sell', async () => {
    const { c, id, sign, mockRpc } = await setup('AnyBlockhash');
    vi.spyOn(Connection.prototype, 'isBlockhashValid').mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      await c.closePosition(id, 100, 'STOP_LOSS').catch(() => undefined);
      expect(sign).toHaveBeenCalled();
    } finally { cleanup(c, mockRpc); }
  });

  it('with the flag off the independent RPC is never asked', async () => {
    const { c, id, sign, mockRpc } = await setup('AnyBlockhash');
    vi.stubEnv('APEX_VERIFY_BLOCKHASH', '');
    const ask = vi.spyOn(Connection.prototype, 'isBlockhashValid');
    try {
      await c.closePosition(id, 100, 'STOP_LOSS').catch(() => undefined);
      expect(ask).not.toHaveBeenCalled();
      expect(sign).toHaveBeenCalled();
    } finally { cleanup(c, mockRpc); }
  });
});
