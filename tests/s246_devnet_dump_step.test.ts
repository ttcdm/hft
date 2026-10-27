import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as web3 from '@solana/web3.js';
import { dumpSeedPlan, makeDumpMarket, failedReadThenDumpStopLoss, type DumpMarket, type HarnessSteps } from '../scripts/devnet_e2e_steps';

const fresh = (vSol: number, realTok = 793_100_000_000_000n) => ({
  virtualSolReserves: BigInt(Math.round(vSol * 1e9)),
  virtualTokenReserves: 1_073_000_000_000_000n,
  realTokenReserves: realTok,
});

/** A pump curve, constant product on the virtual reserves, the fee taken outside the reserves. */
function simulate(st: ReturnType<typeof fresh>, seedSol: number, appSol: number, fee = 0.0125) {
  let vSol = Number(st.virtualSolReserves) / 1e9;
  let vTok = Number(st.virtualTokenReserves);
  const k = vSol * vTok;
  const buy = (sol: number) => { const n = sol * (1 - fee); const out = vTok - k / (vSol + n); vSol += n; vTok -= out; return out; };
  const sell = (tok: number) => { vTok += tok; vSol = k / vTok; };
  const seedTok = buy(seedSol);
  const before = vSol / vTok;
  const appTok = buy(appSol);
  const after = vSol / vTok;
  const entry = (appSol * (1 - fee)) / appTok; // the app's average fill
  sell(seedTok);
  const dumped = vSol / vTok;
  return { before, after, entry, dumped };
}

describe('S246 (h): the dump seed is sized from the coin\'s own curve', () => {
  it('30 SOL virtual reserves: a seed of about 6.3 SOL takes the price under the -20% stop with margin', () => {
    const st = fresh(30);
    const p = dumpSeedPlan(st, 0.02, { maxSeedSol: 10 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.seedSol).toBeGreaterThan(6);
    expect(p.seedSol).toBeLessThan(6.6);
    expect(p.projectedRatio).toBeLessThanOrEqual(0.72);
    const sim = simulate(st, p.seedSol, 0.02);
    expect(sim.dumped / sim.entry).toBeLessThan(0.75);
    expect(p.progressPct).toBeLessThan(55);
  });

  it('1 SOL virtual reserves: about 0.24 SOL, not a fixed 5 SOL', () => {
    const st = fresh(1);
    const p = dumpSeedPlan(st, 0.02, { maxSeedSol: 5 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.seedSol).toBeGreaterThan(0.2);
    expect(p.seedSol).toBeLessThan(0.3);
    const sim = simulate(st, p.seedSol, 0.02);
    expect(sim.dumped / sim.entry).toBeLessThan(0.8);
  });

  it('the devnet figures from the run: the seed fits where a fixed 5 SOL hit CURVE_NEARLY_COMPLETE', () => {
    // 5 SOL would buy 1.0115e15 of 1.073e15 virtual tokens: virtual SOL about 0.3. A 5 SOL seed is refused, the planned one is not.
    const st = fresh(0.3);
    const p = dumpSeedPlan(st, 0.05, { maxSeedSol: 5 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.seedSol).toBeLessThan(0.2);
    expect(simulate(st, p.seedSol, 0.05).dumped / simulate(st, p.seedSol, 0.05).entry).toBeLessThan(0.8);
  });

  it('refuses, with the figure, a seed above DEVNET_DUMP_SOL', () => {
    const p = dumpSeedPlan(fresh(30), 0.02, { maxSeedSol: 5 });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toMatch(/needs is 6\.\d+ SOL, above DEVNET_DUMP_SOL=5/);
  });

  it('refuses a curve close to complete, and one whose progress would be near the 60% cap', () => {
    const late = { ...fresh(1), realTokenReserves: 100_000_000_000_000n }; // 87% already sold
    const p = dumpSeedPlan(late, 0.02, { maxSeedSol: 50 });
    expect(p.ok).toBe(false);
    const mid = { ...fresh(1), realTokenReserves: 400_000_000_000_000n }; // about 50% sold
    const q = dumpSeedPlan(mid, 0.02, { maxSeedSol: 50 });
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.reason).toMatch(/cap/);
  });
});

describe('S246 (h): the second wallet\'s key is kept in the scratch directory', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 's246-'));
  const deps = (conn: any, keyPath: string) => ({ conn, payer: web3.Keypair.generate(), web3, sdk: {}, curve: {}, builder: {}, keyPath });

  it('writes the key (mode 600) before any SOL is sent, and reuses it', async () => {
    const keyPath = path.join(dir(), 'second-wallet.json');
    let keyOnDiskAtSend = false;
    const conn = {
      getLatestBlockhash: async () => ({ blockhash: web3.Keypair.generate().publicKey.toBase58() }),
      sendRawTransaction: async () => { keyOnDiskAtSend = fs.existsSync(keyPath); throw new Error('injected: 429 Too Many Requests'); },
    };
    const m = makeDumpMarket(deps(conn, keyPath));
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    await expect(m.createAndSeed({ appBuySol: 0.02, maxSeedSol: 1 })).rejects.toThrow(/429/);
    expect(keyOnDiskAtSend).toBe(true);
    const again = makeDumpMarket(deps(conn, keyPath));
    expect(again.address).toBe(m.address);
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8')));
    expect(web3.Keypair.fromSecretKey(secret).publicKey.toBase58()).toBe(m.address);
  });

  it('refund sells every coin it recorded, then sends the rest back', async () => {
    const keyPath = path.join(dir(), 'second-wallet.json');
    const mint = web3.Keypair.generate().publicKey.toBase58();
    fs.writeFileSync(keyPath.replace(/\.json$/, '-coins.json'), JSON.stringify([mint]));
    const calls: string[] = [];
    const conn = {
      getTokenAccountsByOwner: async (_o: any, f: any) => { calls.push(`tokens ${f.mint.toBase58()}`); return { value: [] }; },
      getBalance: async () => { calls.push('balance'); return 0; },
    };
    const m = makeDumpMarket(deps(conn, keyPath));
    await m.refund();
    expect(calls).toEqual([`tokens ${mint}`, 'balance']);
  });
});

describe('S246 (h): every path refunds the second wallet', () => {
  const steps = (over: Partial<HarnessSteps> = {}) => {
    const recs: Array<{ step: string; ok: boolean; detail: string }> = [];
    const s = {
      coordinator: {
        executeTrade: vi.fn(async () => ({ success: false, lifecycleState: 'RISK_REJECTED', error: 'refused' })),
        closePosition: vi.fn(async () => ({ success: true })),
        syncRealWalletBalance: vi.fn(async () => undefined),
      },
      curve: { calculateBuyQuote: () => ({}) },
      db: { loadTransactions: () => [], loadPositions: () => [] },
      riskLimits: () => ({ cooldownAfterFailedTradeMs: 0, cooldownPerMintMs: 0 }),
      chainErr: async () => null, mint: 'x', buildBuyRequest: async () => ({}) as any,
      rec: (step: string, ok: boolean, detail: string) => recs.push({ step, ok, detail }),
      link: (x: string) => x, sleep: async () => undefined,
      connection: { sendRawTransaction: async () => 'sig', getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 1 }, value: [] }) },
      ...over,
    } as unknown as HarnessSteps;
    return { s, recs };
  };
  const market = (createAndSeed: DumpMarket['createAndSeed']) => {
    const refund = vi.fn(async () => undefined);
    const m: DumpMarket = { address: 'W2', keyPath: '/scratch/second-wallet.json', createAndSeed, priceSol: async () => 1, sellAll: async () => null, refund };
    return { m, refund };
  };
  const opts = { appBuySol: 0.02, maxSeedSol: 5, buildBuyRequestFor: async () => ({}) as any };

  it('a failed create or seed still refunds (the 5.1 SOL stranded on devnet)', async () => {
    const { s, recs } = steps();
    const { m, refund } = market(async () => { throw new Error('CURVE_NEARLY_COMPLETE: 5 SOL needs 1.0115e15 tokens'); });
    await failedReadThenDumpStopLoss(s, m, opts);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(recs).toEqual([expect.objectContaining({ ok: false, step: expect.stringMatching(/creates and seeds/) })]);
  });

  it('a refused app buy still refunds', async () => {
    const { s, recs } = steps();
    const { m, refund } = market(async () => ({ mint: 'M', curve: 'C', seedSol: 0.2, projectedRatio: 0.7 }));
    await failedReadThenDumpStopLoss(s, m, opts);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(recs.find((r) => /app buy CONFIRMED/.test(r.step))?.ok).toBe(false);
  });

  it('a throw mid-step restores the connection and still refunds', async () => {
    const { s } = steps();
    (s.coordinator.syncRealWalletBalance as any).mockRejectedValue(new Error('boom'));
    const orig = s.connection!.getMultipleAccountsInfoAndContext;
    const { m, refund } = market(async () => ({ mint: 'M', curve: 'C', seedSol: 0.2, projectedRatio: 0.7 }));
    await expect(failedReadThenDumpStopLoss(s, m, opts)).rejects.toThrow('boom');
    expect(refund).toHaveBeenCalledTimes(1);
    expect(s.connection!.getMultipleAccountsInfoAndContext).toBe(orig);
  });

  it('the injected failure reaches the app\'s curve read, which goes through getMultipleAccountsInfoAndContext (R4-9)', async () => {
    // Run 2026-10-27 (QuickNode): "no read of the curve in 10 s". R4-9 moved PumpCurveService.fetchPumpMarketState to
    // getMultipleAccountsInfoAndContext (it needs the context slot), so a hook on getMultipleAccountsInfo alone never saw the read.
    const curve = web3.Keypair.generate().publicKey;
    const appReads: string[] = [];
    const connection: any = {
      getMultipleAccountsInfoAndContext: async (keys: any[]) => ({ context: { slot: 1 }, value: keys.map(() => null) }),
    };
    const origCtx = connection.getMultipleAccountsInfoAndContext;
    // The exit loop's price read, as PumpCurveService does it, every pass (here: every harness sleep)
    const sleep = async () => {
      try { await connection.getMultipleAccountsInfoAndContext([web3.Keypair.generate().publicKey, curve], { minContextSlot: 1 }); appReads.push('ok'); } catch (e: any) { appReads.push(String(e?.message)); }
    };
    const pos = { id: 'P', mint: 'M', status: 'OPEN', entryPriceSol: 1 };
    const { s, recs } = steps({
      connection, sleep,
      db: { loadTransactions: () => [], loadPositions: () => [pos] } as any,
      coordinator: {
        executeTrade: vi.fn(async () => ({ success: true, lifecycleState: 'CONFIRMED' })),
        closePosition: vi.fn(async () => ({ success: true })),
        syncRealWalletBalance: vi.fn(async () => undefined),
      } as any,
    });
    const { m } = market(async () => ({ mint: 'M', curve: curve.toBase58(), seedSol: 0.2, projectedRatio: 0.7 }));
    await failedReadThenDumpStopLoss(s, m, opts);
    expect(recs.find((r) => /took the injected failure/.test(r.step))).toEqual(expect.objectContaining({ ok: true }));
    expect(appReads[0]).toMatch(/harness: injected/);
    expect(appReads.slice(1).every((r) => r === 'ok')).toBe(true); // one call only
    expect(connection.getMultipleAccountsInfoAndContext).toBe(origCtx);
  });
});
