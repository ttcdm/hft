import fs from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey, SolanaJSONRPCError } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_SDK, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA } from '@pump-fun/pump-sdk';
import { PumpCurveService, MIN_CONTEXT_SLOT_RETRY_DELAY_MS } from '../server/solana/pumpCurve';
import { RealMarkPriceService } from '../server/execution/reconciliation';
import { PUMP_FUN_PROGRAM_ID } from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * R13-11 (haiku round 13): the R4-9 minContextSlot read fails outright when the node is behind the floor (JSON-RPC -32016, which web3.js
 * throws), and nothing retried it, so every exit pass in that window had no mark for its stops. The curve read now tries once more a slot
 * later. Real PumpCurveService curve decode and the real exit-path mark reader (RealMarkPriceService); the RPC is MockSolanaRpc with real
 * pump.fun account bytes, and the -32016 is web3.js's own error type.
 */
const dump = (name: string) => {
  const j = JSON.parse(fs.readFileSync(`scripts/localnet/accounts/${name}.json`, 'utf8'));
  return { data: Buffer.from(j.account.data[0], 'base64'), owner: new PublicKey(j.account.owner), lamports: 1, executable: false } as any;
};
const mintAccount = () => { const d = Buffer.alloc(82); d[44] = 6; return { owner: TOKEN_PROGRAM_ID, lamports: 1_461_600, data: d, executable: false }; };
const curveAccount = async () => ({
  owner: PUMP_FUN_PROGRAM_ID, lamports: 1_000_000, executable: false,
  data: await (PUMP_SDK as any).offlinePumpProgram.coder.accounts.encode('bondingCurve', {
    virtualTokenReserves: new BN('800000000000000'), virtualQuoteReserves: new BN('38000000000'), realTokenReserves: new BN('520000000000000'),
    realQuoteReserves: new BN('8000000000'), tokenTotalSupply: new BN('1000000000000000'), complete: false, creator: Keypair.generate().publicKey,
    isMayhemMode: false, isCashbackCoin: false, quoteMint: NATIVE_MINT, creatorFeeBps: new BN(0), canEditCreatorFee: false,
  }),
});
const behind = () => new SolanaJSONRPCError({ code: -32016, message: 'Minimum context slot has not been reached', data: { contextSlot: 1 } }, 'failed to get info about accounts');

async function market() {
  const rpc = new MockSolanaRpc();
  const mint = Keypair.generate().publicKey;
  rpc.setAccount(mint, mintAccount());
  rpc.setAccount(PumpCurveService.getBondingCurveAddress(mint)[0], await curveAccount());
  rpc.setAccount(GLOBAL_PDA, dump('pump_global'));
  rpc.setAccount(PUMP_FEE_CONFIG_PDA, dump('pump_fee_config'));
  const conn = rpc.createConnection();
  // the first read records the context slot, so the next ones carry the minContextSlot floor
  expect(await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' })).not.toBeNull();
  return { conn, mint: mint.toBase58() };
}

describe('R13-11: a node behind the minContextSlot floor is retried once, so the exit path still gets its mark', () => {
  afterEach(() => { vi.restoreAllMocks(); PumpCurveService.cachedGlobal = null; PumpCurveService.cachedFeeConfig = null; });

  it('one -32016 then an answer: the exit-path mark reader gets the curve price (was no mark)', async () => {
    const { conn, mint } = await market();
    const real = conn.getMultipleAccountsInfoAndContext.bind(conn);
    const spy = vi.spyOn(conn, 'getMultipleAccountsInfoAndContext').mockRejectedValueOnce(behind()).mockImplementation(real as any);
    const t0 = Date.now();
    const marks = await RealMarkPriceService.queryOnChainMarkPrices(conn, [mint], 'LIVE');
    expect(marks[mint]?.source).toBe('ON_CHAIN_BONDING_CURVE');
    expect(marks[mint].priceSol).toBeCloseTo(38_000_000_000 / 800_000_000_000_000 / 1_000, 12);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((spy.mock.calls[1][1] as any)?.minContextSlot).toBeGreaterThan(0); // the retry keeps the floor
    expect(Date.now() - t0).toBeGreaterThanOrEqual(MIN_CONTEXT_SLOT_RETRY_DELAY_MS - 5);
  });

  it('still behind on the retry: one retry only, then the read fails as RPC_ERROR (never read below the floor)', async () => {
    const { conn, mint } = await market();
    const spy = vi.spyOn(conn, 'getMultipleAccountsInfoAndContext').mockImplementation(async () => { throw behind(); });
    const r = await PumpCurveService.fetchPumpMarketStateResult({ connection: conn, mint: new PublicKey(mint), executionMode: 'LIVE' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.failure?.reason).toBe('RPC_ERROR');
    expect(r.failure?.message).toMatch(/MIN_CONTEXT_SLOT_NOT_REACHED/);
  });

  it('another RPC error is not retried here', async () => {
    const { conn, mint } = await market();
    const spy = vi.spyOn(conn, 'getMultipleAccountsInfoAndContext').mockRejectedValue(new Error('500 Internal Server Error'));
    const r = await PumpCurveService.fetchPumpMarketStateResult({ connection: conn, mint: new PublicKey(mint), executionMode: 'LIVE' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.failure?.reason).toBe('RPC_ERROR');
  });
});
