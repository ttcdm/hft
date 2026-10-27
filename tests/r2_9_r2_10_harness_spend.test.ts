import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as web3 from '@solana/web3.js';
import {
  RunSpendLedger, runSpendFlagProblems, RUN_AT_RISK_CEILING_SOL, cleanupSell, makeDumpMarket, makeChainKit, releaseGatesOnChain,
  type ChainKit, type HarnessSteps,
} from '../scripts/devnet_e2e_steps';

/**
 * R2-9: nothing in the devnet harness enforced the 1 SOL per-run rule (DEVNET_CURVE_CAP=1 sends about 25.8 SOL to a pusher wallet).
 * R2-10: cleanup swallowed sell errors, so stranded tokens did not fail the run. Real harness step module; the chain kit and the app
 * singletons it drives are doubles (the harness's own network boundary), as in the other harness-step suites.
 */
type Rec = { step: string; ok: boolean; detail: string; skip?: boolean };
const recorder = () => {
  const recs: Rec[] = [];
  return {
    recs,
    rec: (step: string, ok: boolean, detail: string) => { recs.push({ step, ok, detail }); },
    skip: (step: string, detail: string) => { recs.push({ step, ok: true, detail, skip: true }); },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
  };
};
const savedOverride = process.env.DEVNET_ALLOW_OVER_1_SOL;
afterEach(() => { if (savedOverride === undefined) delete process.env.DEVNET_ALLOW_OVER_1_SOL; else process.env.DEVNET_ALLOW_OVER_1_SOL = savedOverride; });

describe('R2-9: a per-run ceiling of 1 SOL at risk', () => {
  it('DEVNET_DUMP_SOL above 1 is refused before the run unless DEVNET_ALLOW_OVER_1_SOL=1', () => {
    expect(RUN_AT_RISK_CEILING_SOL).toBe(1);
    expect(runSpendFlagProblems({ DEVNET_DUMP_SOL: '7' } as any).join()).toMatch(/DEVNET_DUMP_SOL=7 is above the 1 SOL per-run ceiling.*DEVNET_ALLOW_OVER_1_SOL=1/);
    expect(runSpendFlagProblems({ DEVNET_DUMP_SOL: '0.5' } as any)).toEqual([]);
    expect(runSpendFlagProblems({ DEVNET_DUMP_SOL: '7', DEVNET_ALLOW_OVER_1_SOL: '1' } as any)).toEqual([]);
  });

  it('the ledger sums what the steps put at risk and refuses past the ceiling', () => {
    const l = new RunSpendLedger(1, false);
    expect(l.reserve('(h) dump seed', 0.6).ok).toBe(true);
    expect(l.remainingSol()).toBeCloseTo(0.4);
    const r = l.reserve('(k) curve cap', 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/0.600 SOL already at risk .* above the 1 SOL per-run ceiling/);
    expect(new RunSpendLedger(1, true).reserve('(k) curve cap', 25.8).ok).toBe(true);
  });

  it('(k) curve cap: a 25.8 SOL push is refused with a FAIL line and the pusher is never funded', async () => {
    delete process.env.DEVNET_ALLOW_OVER_1_SOL;
    const r = recorder();
    let made = 0;
    const transfers: number[] = [];
    const kit = {
      newWallet: () => ({ publicKey: { toBase58: () => `w${made}` } }),
      transfer: async (_f: any, _t: any, sol: number) => { transfers.push(sol); return 'sig'; },
      create: async () => ({ mint: `M${++made}`, curve: 'c' }),
      buy: async () => 'sig', sellAll: async () => null, refund: async () => undefined,
    } as unknown as ChainKit;
    const feed = { snapshot: () => ({ watching: [], released: Array.from({ length: made }, (_, i) => ({ state: 'READY', reason: 'READY', metrics: { mint: `M${i + 1}` } })), capacity: { active: 0, max: 60 } }) };
    const s = { ...r, link: (x: string) => x, stop: { arm: () => ({ success: true, message: '' }), auto: { setMode: async (mode: string) => ({ ok: true, mode }) } } } as unknown as HarnessSteps;
    const deps = {
      decisions: () => [{ stage: 'execute', outcome: 'WOULD_BUY', reason: 'ok', inputs: { passingSignals: 4 } }],
      curveState: async () => ({ virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n, realTokenReserves: 793_100_000_000_000n }),
      progressPct: () => null, capPct: 60, buildBuyRequestFor: async () => ({}) as any, balanceSol: async () => 100, isLiveArmed: () => false,
    };
    await releaseGatesOnChain(s, kit, feed as any, {}, deps as any, { buyers: 2, waitMs: 1_000, curveCap: true, spend: new RunSpendLedger(1, false) });
    const fail = r.recs.find((x) => x.step.includes('SOL at risk within the per-run ceiling'));
    expect(fail?.ok).toBe(false);
    expect(fail?.detail).toMatch(/push to 62% needs 2\d\.\d{3} SOL at risk.*DEVNET_ALLOW_OVER_1_SOL=1/);
    expect(Math.max(...transfers)).toBeLessThan(1); // only the small pair lends; nothing near the push amount was sent
  });
});

describe('R2-10: a cleanup sell that throws is a FAIL naming the key file and the mint', () => {
  it('cleanupSell records the mint, the wallet and its key file; a wallet holding nothing (null) is silent', async () => {
    const r = recorder();
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r210-'));
    const real = makeChainKit({ conn: {}, web3, sdk: {}, curve: {}, builder: {}, keyDir });
    const w = real.newWallet();
    const kit = { ...real, sellAll: async () => { throw new Error('Blockhash not found'); } } as ChainKit;
    await cleanupSell(r, '(k) release gates', kit, w, 'MintXyz');
    expect(r.recs).toHaveLength(1);
    expect(r.recs[0].ok).toBe(false);
    expect(r.recs[0].detail).toContain('MintXyz');
    expect(r.recs[0].detail).toContain(path.join(keyDir, `${w.publicKey.toBase58()}.json`));
    await cleanupSell(r, '(k) release gates', { ...real, sellAll: async () => null } as ChainKit, w, 'MintXyz');
    expect(r.recs).toHaveLength(1);
  });

  it('the (h) second wallet refund still refunds the SOL, then throws naming the unsold mint and its key file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r210-'));
    const keyPath = path.join(dir, 'second-wallet.json');
    const mint = web3.Keypair.generate().publicKey.toBase58();
    fs.writeFileSync(keyPath.replace(/\.json$/, '-coins.json'), JSON.stringify([mint]));
    const calls: string[] = [];
    const conn = {
      getTokenAccountsByOwner: async () => { calls.push('tokens'); throw new Error('injected: RPC down'); },
      getBalance: async () => { calls.push('balance'); return 0; },
    };
    const m = makeDumpMarket({ conn, payer: web3.Keypair.generate(), web3, sdk: {}, curve: {}, builder: {}, keyPath });
    await expect(m.refund()).rejects.toThrow(new RegExp(`could not sell ${mint}.*key file ${keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(calls).toEqual(['tokens', 'balance']); // the SOL refund ran after the failed sell
  });
});
