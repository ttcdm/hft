import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { startValidator, startLocalnetApp, armLive, waitForPosition, LocalMarket, scratch, cleanupScratch, sleep, type ValidatorHandle, type LocalnetApp } from '../helpers/localnetChain';

/**
 * P1.7 localnet check (R1-71): one position's sell whose RPC reply never comes does not hold another position's stop-loss.
 * Real server process, real exit loop, real pump.fun program (LiteSVM), real signer and transports. The fault is the validator's
 * `localnet_holdNextResponse`: the next sendTransaction lands in the bank but its HTTP reply is never sent.
 *
 *  1. RPC_REQUEST_TIMEOUT_MS=120000, so A's send really stays open for the whole test: B is dumped past its stop after A's sell is
 *     held, and B's STOP_LOSS sell lands while A's row is still OPEN (its sell still running). Before P1.7 the exit pass awaited A's sell,
 *     so B's stop could not fire.
 *  2. The default timeout (1500 ms): A's held send is aborted, P1.5 treats it as unknown and watches it, finds it landed, and A closes
 *     with the held signature; B's stop sells too.
 */
const dir = scratch('long-exitconc-');
let v: ValidatorHandle;
let market: LocalMarket;
let app: LocalnetApp | undefined;
let trader: Keypair;

const held = async (): Promise<string[]> => (await v.rpc('localnet_stats')).held;
const position = async (id: string) => ((await app!.call('GET', '/api/workstation/positions')).json?.positions ?? []).find((p: any) => p.id === id);

async function open(coin: PublicKey): Promise<{ id: string; entry: number }> {
  const r = await app!.call('POST', '/api/execution/trade', { mint: coin.toBase58(), symbol: 'P17', name: 'ExitConcurrency', amountSol: 0.02, confirmLive: true });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.lifecycleState).toBe('CONFIRMED');
  return { id: r.json.positionId, entry: (await position(r.json.positionId)).entryPriceSol };
}

/** Moves the curve to 75% of the entry price (the hard stop is -20%). */
async function breachStop(coin: PublicKey, holders: Keypair[], entry: number): Promise<void> {
  const ratio = await market.dumpTo(coin, holders, (entry * 0.75) / (await market.priceSol(coin)));
  expect(ratio).toBeLessThan(0.85);
}

async function waitHeld(count: number, timeoutMs = 60_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await held();
    if (h.length >= count) return h;
    await sleep(250);
  }
  throw new Error(`no held send after ${timeoutMs} ms (held: ${JSON.stringify(await held())})`);
}

async function boot(tag: string, env: Record<string, string> = {}): Promise<void> {
  const sub = `${dir}/${tag}`;
  fs.mkdirSync(sub);
  const signer = await market.signerKeyFile(sub, 5);
  trader = signer.keypair;
  app = await startLocalnetApp({ dir: sub, validator: v, signerKeyPath: signer.path, env, confluenceThreshold: 0 });
  await armLive(app);
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

describe("P1.7: a held sell does not hold another position's stop-loss", () => {
  it("A's sell reply never comes (long timeout); B breaches its stop and B's sell lands while A is still held", async () => {
    const a = await market.seedCoin(14, 0.6);
    const b = await market.seedCoin(14, 0.6);
    await boot('held', { RPC_REQUEST_TIMEOUT_MS: '120000' });
    const posA = await open(a.mint);
    const posB = await open(b.mint);
    const heldBefore = (await held()).length;

    await breachStop(a.mint, a.wallets, posA.entry);
    await v.rpc('localnet_holdNextResponse'); // the app's next send (A's stop-loss sell) lands, and its reply never comes
    const heldNow = await waitHeld(heldBefore + 1);
    const aSig = heldNow[heldNow.length - 1];

    await breachStop(b.mint, b.wallets, posB.entry);
    const pB = await waitForPosition(app!, (ps) => ps.find((x) => x.id === posB.id && x.status === 'CLOSED'), 75_000, 'B STOP_LOSS close');
    expect(pB.exitReason).toBe('STOP_LOSS');
    expect(pB.exitTxSignature).toBeTruthy();
    expect(pB.exitTxSignature).not.toBe(aSig);
    expect((await v.conn.getSignatureStatuses([pB.exitTxSignature], { searchTransactionHistory: true })).value[0]?.err).toBeNull();
    expect(await market.tokenBalance(trader.publicKey, b.mint)).toBeNull(); // B's tokens left the wallet

    // A is still held: its reply never came, its sell is still running, its row is untouched
    expect(await held()).toContain(aSig);
    const pA = await position(posA.id);
    expect(pA.status).toBe('OPEN');
    expect(pA.exitTxSignature ?? null).not.toBe(aSig);
  }, 300_000);

  it('with the default timeout the held send is aborted, watched and found landed: A closes with the held signature, and B stops out too', async () => {
    const a = await market.seedCoin(14, 0.6);
    const b = await market.seedCoin(14, 0.6);
    await boot('default');
    const posA = await open(a.mint);
    const posB = await open(b.mint);
    const heldBefore = (await held()).length;

    await breachStop(a.mint, a.wallets, posA.entry);
    await v.rpc('localnet_holdNextResponse');
    const heldNow = await waitHeld(heldBefore + 1);
    const aSig = heldNow[heldNow.length - 1];
    await breachStop(b.mint, b.wallets, posB.entry);

    const pB = await waitForPosition(app!, (ps) => ps.find((x) => x.id === posB.id && x.status === 'CLOSED'), 75_000, 'B STOP_LOSS close');
    expect(pB.exitReason).toBe('STOP_LOSS');
    const pA = await waitForPosition(app!, (ps) => ps.find((x) => x.id === posA.id && x.status === 'CLOSED'), 75_000, 'A close after the aborted send');
    expect(pA.exitReason).toBe('STOP_LOSS');
    expect(pA.exitTxSignature).toBe(aSig);
    expect(app!.logs()).toMatch(/RPC_TIMEOUT: sendTransaction/);
  }, 300_000);
});
