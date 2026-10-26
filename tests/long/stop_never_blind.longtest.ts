import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AccountLayout, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda, GLOBAL_CONFIG_PDA, pumpPoolAuthorityPda, coinCreatorVaultAuthorityPda } from '@pump-fun/pump-swap-sdk';
import { startValidator, startLocalnetApp, armLive, waitForPosition, LocalMarket, scratch, cleanupScratch, sleep, type ValidatorHandle, type LocalnetApp } from '../helpers/localnetChain';

/**
 * P1.6 localnet check (R1-19, R1-112, R1-123, R1-31): a LIVE stop-loss is not blinded by one failed price read, and fires across a
 * migration to the PumpSwap pool with no manual close. Real server process, real exit loop, real pump.fun and PumpSwap programs (LiteSVM),
 * real signer and transports. Before P1.6 a mint whose price read failed once was not read again for 60 s (doubling to 10 min), LIVE
 * positions included, and a migrated position was priced from a 15 s pool cache that also remembered "no pool".
 *
 *  1. `localnet_failNextReads(1, 'getMultipleAccounts', <curve>)` fails the app's next curve read; then another wallet dumps the curve
 *     below the -20% hard stop. The STOP_LOSS sell lands and the journal has its EXITED decision within a couple of 3 s passes.
 *  2. The curve is flipped complete with no pool for a few passes (the gap where no price exists), then the canonical pool is written into
 *     the bank at -30% of the entry price (as in scripts/localnet/e2e.ts step h). The exit loop alone sells it through PumpSwap.
 *
 * The waits below are deadlines for a condition, not timing assertions: each is far shorter than the old 60 s back-off.
 */
const PASS_DEADLINE_MS = 25_000; // a few 3 s exit passes plus the sell; the old back-off alone was 60 s
const dir = scratch('long-stopblind-');
let v: ValidatorHandle;
let market: LocalMarket;
let app: LocalnetApp | undefined;
let trader: Keypair;

const position = async (id: string) => ((await app!.call('GET', '/api/workstation/positions')).json?.positions ?? []).find((p: any) => p.id === id);
const curveOf = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0];

async function boot(tag: string): Promise<void> {
  const sub = `${dir}/${tag}`;
  fs.mkdirSync(sub);
  const signer = await market.signerKeyFile(sub, 5);
  trader = signer.keypair;
  app = await startLocalnetApp({ dir: sub, validator: v, signerKeyPath: signer.path });
  await armLive(app);
}

async function open(coin: PublicKey): Promise<{ id: string; entry: number }> {
  const r = await app!.call('POST', '/api/execution/trade', { mint: coin.toBase58(), symbol: 'P16', name: 'StopNeverBlind', amountSol: 0.02, confirmLive: true });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.lifecycleState).toBe('CONFIRMED');
  return { id: r.json.positionId, entry: (await position(r.json.positionId)).entryPriceSol };
}

/** EXITED decisions the app journaled for this position (read-only view of its database). */
function exitedDecisions(positionId: string): Array<{ reason: string }> {
  const db = new DatabaseSync(app!.dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT reason FROM decisions WHERE position_id = ? AND outcome = 'EXITED'`).all(positionId) as any;
  } finally {
    db.close();
  }
}

const setAccount = (pk: PublicKey, lamports: number, data: Buffer, owner: PublicKey) =>
  v.rpc('localnet_setAccount', [pk.toBase58(), { lamports, dataBase64: data.toString('base64'), owner: owner.toBase58() }]);

const tokenAcct = (mint: PublicKey, owner: PublicKey, amount: bigint, native: boolean) => {
  const b = Buffer.alloc(165);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: native ? 1 : 0, isNative: native ? 2_039_280n : 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default } as any, b);
  return b;
};

/** Marks the bonding curve complete (a migration has started; no pool yet). */
async function completeCurve(mint: PublicKey): Promise<void> {
  const pk = curveOf(mint);
  const acct = await v.conn.getAccountInfo(pk);
  const data = Buffer.from(acct!.data);
  data[48] = 1;
  await setAccount(pk, acct!.lamports, data, acct!.owner);
}

/** Writes the canonical SOL-quoted pool and its vaults into the bank (scripts/localnet/e2e.ts step h), priced at `priceSol` per UI token. */
async function writePool(mint: PublicKey, priceSol: number): Promise<PublicKey> {
  const poolPk = canonicalPumpPoolPda(mint);
  const baseVault = Keypair.generate().publicKey;
  const quoteVault = Keypair.generate().publicKey;
  const lpMint = Keypair.generate().publicKey;
  const poolBase = 200_000_000_000_000n; // 2e8 tokens (6 decimals)
  const poolQuote = BigInt(Math.round(priceSol * 2e8 * 1e9));
  await setAccount(baseVault, 2_039_280, tokenAcct(mint, poolPk, poolBase, false), TOKEN_2022_PROGRAM_ID); // pump v2 coins are Token-2022
  await setAccount(quoteVault, 2_039_280 + Number(poolQuote), tokenAcct(NATIVE_MINT, poolPk, poolQuote, true), TOKEN_PROGRAM_ID);
  const lpData = Buffer.alloc(82); lpData[45] = 1;
  await setAccount(lpMint, 1_461_600, lpData, TOKEN_PROGRAM_ID);
  const seeds = [Buffer.from('pool'), Buffer.from(new Uint16Array([0]).buffer), pumpPoolAuthorityPda(mint).toBuffer(), mint.toBuffer(), NATIVE_MINT.toBuffer()];
  let bump = -1;
  for (let b = 255; b >= 0 && bump < 0; b--) {
    try { if (PublicKey.createProgramAddressSync([...seeds, Buffer.from([b])], PUMP_AMM_PROGRAM_ID).equals(poolPk)) bump = b; } catch { /* off-curve required: next bump */ }
  }
  expect(bump).toBeGreaterThanOrEqual(0);
  const prog: any = (PUMP_AMM_SDK as any).offlineProgram;
  const poolData: Buffer = await prog.coder.accounts.encode('pool', {
    poolBump: bump, index: 0, creator: pumpPoolAuthorityPda(mint), baseMint: mint, quoteMint: NATIVE_MINT, lpMint,
    poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault, lpSupply: new BN(1_000_000), coinCreator: market.creator.publicKey,
    isMayhemMode: false, isCashbackCoin: false, virtualQuoteReserves: new BN(0), creatorFeeBps: new BN(0), canEditCreatorFee: false,
  });
  await setAccount(poolPk, 5_000_000, poolData, PUMP_AMM_PROGRAM_ID);
  // the accounts a PumpSwap sell touches besides the pool: protocol-fee recipient WSOL account, creator-vault WSOL account
  const globalInfo = await v.conn.getAccountInfo(GLOBAL_CONFIG_PDA);
  const recip: PublicKey | undefined = globalInfo ? prog.coder.accounts.decode('globalConfig', globalInfo.data)?.protocolFeeRecipients?.[0] : undefined;
  for (const owner of [recip, coinCreatorVaultAuthorityPda(market.creator.publicKey)]) {
    if (!owner) continue;
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
    if (!(await v.conn.getAccountInfo(ata))) await setAccount(ata, 2_039_280, tokenAcct(NATIVE_MINT, owner, 0n, true), TOKEN_PROGRAM_ID);
  }
  return poolPk;
}

beforeAll(async () => {
  v = await startValidator(dir);
  market = await LocalMarket.connect(v);
}, 120_000);

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

afterAll(async () => {
  await v?.stop();
  cleanupScratch(dir);
});

describe('P1.6: a LIVE stop-loss is never blind', () => {
  it('one failed curve read, then a dump from another wallet: STOP_LOSS sells and is journaled EXITED within a few passes', async () => {
    const coin = await market.seedCoin(14, 0.6);
    await boot('failread');
    const pos = await open(coin.mint);

    const before = (await v.methodCounts()).getMultipleAccounts ?? 0;
    await v.rpc('localnet_failNextReads', [1, 'getMultipleAccounts', curveOf(coin.mint).toBase58()]);
    // the app's own exit pass reads the curve every 3 s; wait until a read has happened since the fault was armed (it took the failure)
    for (let i = 0; i < 40 && ((await v.methodCounts()).getMultipleAccounts ?? 0) <= before; i++) await sleep(250);
    await sleep(500);

    const ratio = await market.dumpTo(coin.mint, coin.wallets, (pos.entry * 0.7) / (await market.priceSol(coin.mint)));
    expect(ratio).toBeLessThan(0.8);
    const closed = await waitForPosition(app!, (ps) => ps.find((x) => x.id === pos.id && x.status === 'CLOSED'), PASS_DEADLINE_MS, 'STOP_LOSS after a failed read');
    expect(closed.exitReason).toBe('STOP_LOSS');
    expect((await v.conn.getSignatureStatuses([closed.exitTxSignature], { searchTransactionHistory: true })).value[0]?.err).toBeNull();
    expect(exitedDecisions(pos.id).map((d) => d.reason)).toEqual(['STOP_LOSS']);
    expect(await market.tokenBalance(trader.publicKey, coin.mint)).toBeNull(); // the tokens left the wallet
  }, 300_000);

  it('curve completes, no pool for a few passes, then the pool appears at -30%: the exit loop alone sells STOP_LOSS through PumpSwap', async () => {
    const coin = await market.seedCoin(14, 0.6);
    await boot('migrate');
    const pos = await open(coin.mint);

    await completeCurve(coin.mint);
    await sleep(7_000); // two or three passes in the gap: no curve price and no pool, so no mark at all
    expect((await position(pos.id)).status).toBe('OPEN');

    const poolPk = await writePool(coin.mint, pos.entry * 0.7);
    const closed = await waitForPosition(app!, (ps) => ps.find((x) => x.id === pos.id && x.status === 'CLOSED'), PASS_DEADLINE_MS, 'STOP_LOSS through PumpSwap');
    expect(closed.exitReason).toBe('STOP_LOSS');
    expect(closed.venue).toBe('PUMPSWAP');
    expect(closed.poolAddress).toBe(poolPk.toBase58());
    expect((await v.conn.getSignatureStatuses([closed.exitTxSignature], { searchTransactionHistory: true })).value[0]?.err).toBeNull();
    expect(exitedDecisions(pos.id).map((d) => d.reason)).toEqual(['STOP_LOSS']);
  }, 300_000);
});
