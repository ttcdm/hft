import fs from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_SDK, GLOBAL_PDA } from '@pump-fun/pump-sdk';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda, pumpPoolAuthorityPda } from '@pump-fun/pump-swap-sdk';
import { ExecutionCoordinator, SELL_SLIPPAGE_LADDER_BPS } from '../server/execution/coordinator';
import { RealMarkPriceService, TradeReconciler } from '../server/execution/reconciliation';
import { PumpCurveService, PUMP_SELL_FEE_CEILING_BPS } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { PUMP_FUN_PROGRAM_ID } from '../server/solana/programs';
import { localSigner } from '../server/solana/signer';
import { txBuilder } from '../server/solana/transactionBuilder';
import { executionConfig } from '../server/solana/executionConfig';
import { workstationDb } from '../server/db/database';
import { OperatorCloseSchema } from '../server/execution/tradeInputs';
import { ClosePositionSchema } from '../server/middleware/enterprise';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

/**
 * P1.6: a LIVE stop-loss is never blind or blocked (R1-19, R1-112, R1-31, R1-123, R1-30, N-44, N-42), and a LIVE close on an RPC the cluster
 * check does not trust does not close the row from that RPC's empty balance.
 *
 * Real ExecutionCoordinator, ExitEngine, mark service, venue resolution, curve decode and sell quote, and SQLite. Doubles sit at the RPC
 * boundary (the singleton's Connection, or tests/e2e/helpers/mockRpc.ts), the signer, the transaction builder (so no real program is needed
 * to build a sell) and the fill reconciler. Wallet keys are freshly generated throwaway values.
 */
const ENTRY = 0.0001;
const seeded: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
  for (const id of seeded.splice(0)) {
    const p = workstationDb.loadPositions().find((x) => x.id === id);
    if (p && p.status !== 'CLOSED') { p.status = 'CLOSED'; p.tokenQuantityRaw = '0'; workstationDb.savePosition(p); }
  }
});

function seedLive(over: Record<string, unknown> = {}): { id: string; mint: string } {
  const id = `p16-${Math.random().toString(36).slice(2, 10)}`;
  const mint = (over.mint as string) ?? Keypair.generate().publicKey.toBase58();
  workstationDb.savePosition({
    id, mint, symbol: 'P16', name: 'P16', tokenDecimals: 6, tokenQuantityRaw: '1000000000', costBasisLamports: 100_000_000,
    entryPriceSol: ENTRY, currentPriceSol: ENTRY, currentValueSol: 0.1, realizedPnLSol: 0, entryTxSignature: `sig-${id}`,
    entryTimestamp: Date.now() - 60_000, lastMarkTimestamp: Date.now(), executionMode: 'LIVE', status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
    walletPubkey: localSigner.getStatus() === 'READY' ? localSigner.getPublicKey().toBase58() : undefined, // R4-2: bound to the test signer
    ...over,
  } as any);
  seeded.push(id);
  return { id, mint };
}

const row = (id: string) => workstationDb.loadPositions().find((p) => p.id === id)!;

/** A clock the test moves forward (the "injected now"); setTimeout is untouched. */
function clock(): { now: number } {
  const c = { now: Date.now() };
  vi.spyOn(Date, 'now').mockImplementation(() => c.now);
  return c;
}

describe('R1-19 / R1-112: one failed price read does not blind a LIVE stop-loss', () => {
  it('c4-style: the read returns nothing once, then -30%; the second pass sells STOP_LOSS (no back-off is cleared by hand)', async () => {
    const t = clock();
    const { c, send, build } = await liveCoordinator();
    stubCurveSell();
    const { id, mint } = seedLive({ lastMarkTimestamp: t.now - 10_000 });
    vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices')
      .mockResolvedValueOnce({})
      .mockImplementation(async (_c, mints) => (mints.includes(mint) ? { [mint]: { priceSol: ENTRY * 0.7, source: 'ON_CHAIN_BONDING_CURVE', timestamp: t.now } } : {}));

    await c.evaluateAndProcessExits();
    expect(send).not.toHaveBeenCalled(); // pass 1: no new price, the last one is at entry
    expect(row(id).status).toBe('OPEN');

    t.now += 3_000; // one exit-loop tick later
    await c.evaluateAndProcessExits();
    expectStopLossSent(id, build, send);
  });

  it('a stale LIVE mark already past the hard stop still fires STOP_LOSS while no price can be read; a stale mark above the stop fires nothing', async () => {
    const t = clock();
    const { c, send, build } = await liveCoordinator();
    stubCurveSell();
    const breached = seedLive({ lastMarkTimestamp: t.now - 30_000, currentPriceSol: ENTRY * 0.7 });
    const above = seedLive({ lastMarkTimestamp: t.now - 30_000, currentPriceSol: ENTRY * 0.9 });
    vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockResolvedValue({});

    await c.evaluateAndProcessExits();
    expectStopLossSent(breached.id, build, send);
    expect(row(above.id).status).toBe('OPEN');
  });
});

describe('R1-31 / R1-123: a migrated LIVE position is marked from the pool as it is now, not from the 15 s cache', () => {
  it('the pool vault balances change between two passes 3 s apart; the second pass sees the new price and sells STOP_LOSS', async () => {
    const t = clock();
    const { c, conn, send } = await liveCoordinator();
    const mint = Keypair.generate().publicKey;
    const poolPk = canonicalPumpPoolPda(mint);
    const baseVault = Keypair.generate().publicKey;
    const quoteVault = Keypair.generate().publicKey;
    const tokenAcct = (m: PublicKey, owner: PublicKey, amount: bigint) => {
      const b = Buffer.alloc(165);
      AccountLayout.encode({ mint: m, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default } as any, b);
      return b;
    };
    const poolData: Buffer = await (PUMP_AMM_SDK as any).offlineProgram.coder.accounts.encode('pool', {
      poolBump: 255, index: 0, creator: pumpPoolAuthorityPda(mint), baseMint: mint, quoteMint: NATIVE_MINT, lpMint: Keypair.generate().publicKey,
      poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault, lpSupply: new BN(1_000_000), coinCreator: Keypair.generate().publicKey,
      isMayhemMode: false, isCashbackCoin: false, virtualQuoteReserves: new BN(0), creatorFeeBps: new BN(0), canEditCreatorFee: false,
    });
    const mintData = Buffer.alloc(82);
    mintData[44] = 6;
    const BASE = 200_000_000_000_000n; // 2e8 tokens
    let quoteLamports = 20_000_000_000n; // 20 SOL: 1e-7 SOL per token
    const account = (pk: PublicKey): any => {
      const k = pk.toBase58();
      if (k === mint.toBase58()) return { owner: TOKEN_PROGRAM_ID, lamports: 1_461_600, data: mintData, executable: false };
      if (k === poolPk.toBase58()) return { owner: PUMP_AMM_PROGRAM_ID, lamports: 5_000_000, data: poolData, executable: false };
      if (k === baseVault.toBase58()) return { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, data: tokenAcct(mint, poolPk, BASE), executable: false };
      if (k === quoteVault.toBase58()) return { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, data: tokenAcct(NATIVE_MINT, poolPk, quoteLamports), executable: false };
      return null; // the bonding curve is gone (migrated)
    };
    vi.spyOn(conn, 'getAccountInfo').mockImplementation((async (pk: PublicKey) => account(pk)) as any);
    vi.spyOn(conn, 'getMultipleAccountsInfo').mockImplementation((async (pks: PublicKey[]) => pks.map(account)) as any);
    const { id } = seedLive({ mint: mint.toBase58(), venue: 'PUMPSWAP', poolAddress: poolPk.toBase58(), entryPriceSol: 1e-7, currentPriceSol: 1e-7, lastMarkTimestamp: t.now });
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMPSWAP', isMigrated: true, poolAddress: poolPk } as any);
    const swapSell = vi.spyOn(PumpSwapVenueService, 'buildPumpSwapSellInstructions').mockResolvedValue({ instructions: [] } as any);
    vi.spyOn(txBuilder, 'buildCustomVersionedTransaction').mockImplementation(async () => signedTx() as any);

    await c.evaluateAndProcessExits();
    expect(row(id).markSource).toBe('ON_CHAIN_PUMPSWAP_POOL');
    expect(send).not.toHaveBeenCalled();
    expect(row(id).status).toBe('OPEN');

    quoteLamports = 14_000_000_000n; // someone dumped into the pool: -30%
    t.now += 3_000;
    await c.evaluateAndProcessExits();
    expect(swapSell).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(row(id).status).toBe('CLOSED');
    expect(row(id).exitReason).toMatch(/STOP_LOSS/);
    expect(row(id).currentPriceSol).toBeLessThan(1e-7);
  });
});

// ---- the LIVE sell path, down to the mock RPC's sendRawTransaction ----

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

const dump = (name: string) => {
  const j = JSON.parse(fs.readFileSync(`scripts/localnet/accounts/${name}.json`, 'utf8'));
  return { data: Buffer.from(j.account.data[0], 'base64'), owner: new PublicKey(j.account.owner), lamports: 1, executable: false } as any;
};

async function liveCoordinator(opts: { genesisHash?: string } = {}) {
  const realConfig = executionConfig.getConfig();
  vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...realConfig, jitoBlockEngineUrl: '' }); // the RPC transport sends
  const owner = Keypair.generate();
  const mockRpc = new MockSolanaRpc();
  if (opts.genesisHash) mockRpc.genesisHash = opts.genesisHash;
  vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
  vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(owner.publicKey);
  vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
  const conn = mockRpc.createConnection();
  const c = new ExecutionCoordinator(conn);
  cleanups.push(() => {
    c.cleanup();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    mockRpc.clear();
  });
  const send = vi.spyOn(conn, 'sendRawTransaction');
  vi.spyOn(c.getJitoTransport(), 'getTipFloorLamports').mockResolvedValue(null as any); // the public tip-floor service is a network call
  const build = vi.spyOn(txBuilder, 'buildSellTransaction').mockImplementation(async () => signedTx() as any);
  vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
  vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
    success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
    actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
    actualJitoTipLamports: 0, actualRealizedPnLSol: -0.05, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
  } as any);
  return { c, conn, mockRpc, owner: owner.publicKey, send, build };
}

/** The sell path below closePosition: venue and curve state are read from doubles, the rest (closePosition, build call, send) is real. */
function stubCurveSell() {
  vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE', isMigrated: false } as any);
  vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
  vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
}

/** A STOP_LOSS SELL reached the send: the sell was built for the whole balance and sendRawTransaction was called. */
function expectStopLossSent(id: string, built: { mock: { calls: any[][] } }, send: { mock: { calls: any[][] } }, qty = 1_000_000_000n) {
  expect(built.mock.calls).toHaveLength(1);
  expect((built.mock.calls[0][1] as any).amountTokens).toBe(qty);
  expect(send.mock.calls).toHaveLength(1);
  expect(row(id).status).toBe('CLOSED');
  expect(row(id).exitReason).toMatch(/STOP_LOSS/);
}

const alerts = (c: ExecutionCoordinator, id: string) => c.getOperatorAlerts().filter((a) => a.positionId === id).map((a) => a.code);

describe('R1-30: errors thrown before a sell is sent do not walk the slippage ladder, and a fee-rounding mismatch does not block a stop', () => {
  it('QUOTE_MATH_DISCREPANCY five times: slippage stays at the first rung, nothing is sent, EXIT_QUOTE_FAILING (not EXIT_FAILING) is raised', async () => {
    const { c, send } = await liveCoordinator();
    const { id } = seedLive();
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE', isMigrated: false } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockImplementation(() => {
      throw new Error('QUOTE_MATH_DISCREPANCY: Custom sell math (4689 net) diverges from official SDK (4688 net) in LIVE mode. Failing closed.');
    });
    for (let i = 0; i < 5; i++) {
      const res = await c.closePosition(id, 100, 'STOP_LOSS');
      expect(res.error).toMatch(/^QUOTE_MATH_DISCREPANCY/);
    }
    expect(send).not.toHaveBeenCalled();
    expect(c.exitSlippageBps(id)).toBe(SELL_SLIPPAGE_LADDER_BPS[0]);
    expect(c.getExitFailureCount(id)).toBe(0);
    expect(c.exitRetryWaitMs(id)).toBe(0);
    expect(alerts(c, id)).toContain('EXIT_QUOTE_FAILING');
    expect(alerts(c, id)).not.toContain('EXIT_FAILING');
  });

  it('a one-lamport disagreement between the app and the official SDK: the real sell quote still builds and sends the STOP_LOSS', async () => {
    const { c, build, send } = await liveCoordinator();
    PumpCurveService.cachedGlobal = PUMP_SDK.decodeGlobal(dump('pump_global'));
    PumpCurveService.cachedFeeConfig = PUMP_SDK.decodeFeeConfig(dump('pump_fee_config'));
    // The devnet fee schedule charges 95 bps protocol fee; a state that says 94 makes the app's net exactly 1 lamport above the SDK's for
    // this amount (100 tokens: 4689 vs 4688 lamports).
    const state = createSimulatedBondingCurveState({
      creator: Keypair.generate().publicKey, virtualSolReserves: 38_000_000_000n, virtualTokenReserves: 800_000_000_000_000n,
      realTokenReserves: 520_000_000_000_000n, realSolReserves: 8_000_000_000n, protocolFeeBps: 94, creatorFeeBps: 30,
    });
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(state);
    const quote = vi.spyOn(PumpCurveService, 'calculateSellQuote');
    const { id } = seedLive({ tokenQuantityRaw: '100000000', currentValueSol: 0.0000047 });
    const res = await c.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success, res.error).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    const params = build.mock.calls[0][1] as any;
    expect(params.amountTokens).toBe(100_000_000n);
    expect(params.minSolOutputLamports).toBe(BigInt(quote.mock.results[0].value.minOutputLamports));
    expect(params.minSolOutputLamports > 0n).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('N-44: a fractional sell percentage', () => {
  it('both close schemas refuse 33.5 and accept 33', () => {
    expect(OperatorCloseSchema.safeParse({ positionId: 'p', sellPct: 33.5 }).success).toBe(false);
    expect(ClosePositionSchema.safeParse({ positionId: 'p', sellPct: 33.5 }).success).toBe(false);
    expect(OperatorCloseSchema.safeParse({ positionId: 'p', sellPct: 33 }).success).toBe(true);
    expect(ClosePositionSchema.safeParse({ positionId: 'p', sellPct: 33 }).success).toBe(true);
  });

  it('closePosition(id, 33.5) on a LIVE position sells floor(raw * 335 / 1000), and the failure count and slippage stay at rest', async () => {
    const { c } = await liveCoordinator();
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE', isMigrated: false } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    const quote = vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    const { id } = seedLive({ tokenQuantityRaw: '1000000001' });
    const res = await c.closePosition(id, 33.5, 'TAKE_PROFIT_1');
    expect(res.error ?? '').not.toMatch(/BigInt/);
    expect(quote).toHaveBeenCalledTimes(1);
    expect((quote.mock.calls[0][0] as any).tokenAmountRaw).toBe(335_000_000n); // floor(1_000_000_001 * 335 / 1000)
    expect(c.getExitFailureCount(id)).toBe(0);
    expect(c.exitSlippageBps(id)).toBe(SELL_SLIPPAGE_LADDER_BPS[0]);
  });
});

describe('R3-5: closePosition clamps the sell percentage to 1..100', () => {
  it('closePosition(id, 150) sells the whole balance; closePosition(id, 0.2) sells 1%', async () => {
    const { c, build } = await liveCoordinator();
    stubCurveSell();
    const over = seedLive({ tokenQuantityRaw: '1000000001' });
    const res = await c.closePosition(over.id, 150, 'STOP_LOSS');
    expect(res.success, res.error).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect((build.mock.calls[0][1] as any).amountTokens).toBe(1_000_000_001n); // 150 -> 100%, never more than the balance

    const under = seedLive({ tokenQuantityRaw: '1000000000' });
    await c.closePosition(under.id, 0.2, 'STOP_LOSS');
    expect(build).toHaveBeenCalledTimes(2);
    expect((build.mock.calls[1][1] as any).amountTokens).toBe(10_000_000n); // 0.2 -> 1% = floor(1e9 * 100 / 10000)
  });
});

describe('N-42: a curve that cannot be fully read in LIVE', () => {
  const curveAccount = async () => ({
    owner: PUMP_FUN_PROGRAM_ID, lamports: 1_000_000, executable: false,
    data: await (PUMP_SDK as any).offlinePumpProgram.coder.accounts.encode('bondingCurve', {
      virtualTokenReserves: new BN('800000000000000'), virtualQuoteReserves: new BN('38000000000'), realTokenReserves: new BN('520000000000000'),
      realQuoteReserves: new BN('8000000000'), tokenTotalSupply: new BN('1000000000000000'), complete: false, creator: Keypair.generate().publicKey,
      isMayhemMode: false, isCashbackCoin: false, quoteMint: NATIVE_MINT, creatorFeeBps: new BN(0), canEditCreatorFee: false,
    }),
  });
  const mintAccount = () => { const d = Buffer.alloc(82); d[44] = 6; return { owner: TOKEN_PROGRAM_ID, lamports: 1_461_600, data: d, executable: false }; };

  it('the fee config is missing but the fee recipients resolve: a STOP_LOSS is built on the curve with the minimum output at the highest fee tier', async () => {
    const { c, mockRpc, build } = await liveCoordinator();
    const mint = Keypair.generate().publicKey;
    mockRpc.setAccount(mint, mintAccount());
    mockRpc.setAccount(PumpCurveService.getBondingCurveAddress(mint)[0], await curveAccount());
    mockRpc.setAccount(GLOBAL_PDA, dump('pump_global')); // Global decodes; the FeeConfig account is absent
    const quote = vi.spyOn(PumpCurveService, 'calculateSellQuote');
    const venue = vi.spyOn(PumpSwapVenueService, 'resolveVenue');
    const { id } = seedLive({ mint: mint.toBase58() });

    const res = await c.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success, res.error).toBe(true);
    expect((await venue.mock.results[0].value).venue).toBe('PUMP_BONDING_CURVE');
    const usedState = (quote.mock.calls[0][0] as any).state;
    expect(usedState.unverifiedFeeCeilingBps).toBe(PUMP_SELL_FEE_CEILING_BPS);
    expect(build).toHaveBeenCalledTimes(1);
    expect((build.mock.calls[0][1] as any).minSolOutputLamports).toBe(BigInt(quote.mock.results[0].value.minOutputLamports));
    // the same state never prices a buy
    expect(() => PumpCurveService.calculateBuyQuote({ state: usedState, amountSol: 0.01, executionMode: 'LIVE' })).toThrow(/DYNAMIC_FEE_CALCULATION_FAILED/);
    // and a LIVE fetch still returns no state for it, with the reason
    const read = await PumpCurveService.fetchPumpMarketStateResult({ connection: (c as ExecutionCoordinator).getConnection(), mint, executionMode: 'LIVE' });
    expect(read.state).toBeNull();
    expect(read.failure?.reason).toBe('FEE_CONFIG_MISSING');
  });

  it('a curve that does not decode reports the curve-read reason, not UNKNOWN_TRADING_VENUE, and counts as no attempt', async () => {
    const { c, mockRpc, send } = await liveCoordinator();
    const mint = Keypair.generate().publicKey;
    mockRpc.setAccount(mint, mintAccount());
    mockRpc.setAccount(PumpCurveService.getBondingCurveAddress(mint)[0], { owner: PUMP_FUN_PROGRAM_ID, lamports: 1_000_000, data: Buffer.alloc(200, 7), executable: false });
    const { id } = seedLive({ mint: mint.toBase58() });

    const res = await c.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^CURVE_READ_FAILED \(BONDING_CURVE_DECODE_FAILED\)/);
    expect(res.error).not.toMatch(/UNKNOWN_TRADING_VENUE/);
    expect(send).not.toHaveBeenCalled();
    expect(c.getExitFailureCount(id)).toBe(0);
    expect(alerts(c, id)).toContain('EXIT_QUOTE_FAILING');
  });
});

describe('a LIVE close does not trust an empty balance from an RPC it cannot trust', () => {
  it('wrong-cluster RPC (clusterProblem set): the close is refused CLUSTER_GUARD before any balance read, the position stays OPEN, no attempt is counted', async () => {
    const { c, conn, send } = await liveCoordinator({ genesisHash: Keypair.generate().publicKey.toBase58() });
    await vi.waitFor(() => expect(c.getClusterStatus().problem).toMatch(/genesis hash/), { timeout: 5_000 });
    const balance = vi.spyOn(conn, 'getTokenAccountBalance').mockRejectedValue(new Error('failed to get token account balance: Invalid param: could not find account'));
    const { id } = seedLive();

    const res = await c.closePosition(id, 100, 'Operator close');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^CLUSTER_GUARD/);
    expect(balance).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(row(id).status).toBe('OPEN');
    expect(row(id).tokenQuantityRaw).toBe('1000000000');
    expect(c.getExitFailureCount(id)).toBe(0);
  });

  it('a zero balance answered from a slot before the buy landed does not close the row; the same answer from a later slot does', async () => {
    const { c, mockRpc, owner, send } = await liveCoordinator();
    const { id, mint } = seedLive({ entrySlot: 500 });
    mockRpc.setTokenAccount(PumpCurveService.getAssociatedTokenAddress(new PublicKey(mint), owner, TOKEN_PROGRAM_ID), '0');

    mockRpc.setSlot(400); // a lagging node
    const lag = await c.closePosition(id, 100, 'STOP_LOSS');
    expect(lag.success).toBe(false);
    expect(lag.error).toMatch(/^BALANCE_UNTRUSTED/);
    expect(row(id).status).toBe('OPEN');
    expect(c.getExitFailureCount(id)).toBe(0);

    mockRpc.setSlot(600);
    const ok = await c.closePosition(id, 100, 'STOP_LOSS');
    expect(ok.success, ok.error).toBe(true);
    expect(row(id).status).toBe('CLOSED');
    expect(row(id).exitReason).toMatch(/^RECONCILED_ZERO_BALANCE/);
    expect(send).not.toHaveBeenCalled();
  });
});
