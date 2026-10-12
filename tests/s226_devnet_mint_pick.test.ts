import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  mintFromProgramDataLog, scrubUrls, recentCreateMints, classifyProbe, orderCandidates, waiveHolderChecks, harnessEligibilityInput,
  CREATE_EVENT_DISC, TRADE_EVENT_DISC, type MintProbe,
} from '../scripts/devnet_mints';
import { liveBuyRequest } from '../scripts/devnet_funding';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { MAX_CREATOR_HOLDING_PCT, MAX_TOP10_HOLDERS_PCT } from '../server/solana/executionConfig';
import { createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

const limits = { maxCreatorPct: MAX_CREATOR_HOLDING_PCT, maxTop10Pct: MAX_TOP10_HOLDERS_PCT };
const probe = (mint: string, creatorPct: number | null, top10Pct: number | null, usable = true): MintProbe => ({ mint, usable, creatorPct, top10Pct });
const str = (s: string) => Buffer.concat([Buffer.from(new Uint32Array([Buffer.byteLength(s)]).buffer), Buffer.from(s)]);
const log = (b: Buffer) => `Program data: ${b.toString('base64')}`;

describe('S226: the devnet harness picks a mint the app accepts, and only waives what it must', () => {
  it('reads the mint from CreateEvent and TradeEvent log lines, and nothing else', () => {
    const mint = Keypair.generate().publicKey;
    const create = Buffer.concat([CREATE_EVENT_DISC, str('n'), str('S'), str('u'), mint.toBuffer(), Buffer.alloc(64)]);
    const trade = Buffer.concat([TRADE_EVENT_DISC, mint.toBuffer(), Buffer.alloc(40)]);
    expect(mintFromProgramDataLog(log(create))).toBe(mint.toBase58());
    expect(mintFromProgramDataLog(log(trade))).toBe(mint.toBase58());
    expect(mintFromProgramDataLog(log(Buffer.concat([Buffer.alloc(8, 1), mint.toBuffer()])))).toBeNull();
    expect(mintFromProgramDataLog('Program log: hello')).toBeNull();
    expect(mintFromProgramDataLog(log(Buffer.alloc(4)))).toBeNull();
  });

  it('recentCreateMints returns distinct mints, skips failed transactions, and survives an RPC error', async () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const ev = (m: PublicKey) => log(Buffer.concat([TRADE_EVENT_DISC, m.toBuffer(), Buffer.alloc(40)]));
    const txs: Record<string, any> = { s1: { meta: { logMessages: [ev(a)] } }, s2: { meta: { logMessages: [ev(a), ev(b)] } }, s4: null };
    const conn: any = {
      getSignaturesForAddress: async () => [{ signature: 's1' }, { signature: 's2' }, { signature: 's3', err: {} }, { signature: 's4' }, { signature: 's5' }],
      getTransaction: async (sig: string) => { if (sig === 's5') throw new Error('429 https://x.example/key123'); return txs[sig]; },
    };
    expect(await recentCreateMints(conn, new PublicKey(a), { pauseMs: 0 })).toEqual([a.toBase58(), b.toBase58()]);
    const dead: any = { getSignaturesForAddress: async () => { throw new Error('429'); }, getTransaction: async () => null };
    expect(await recentCreateMints(dead, new PublicKey(a), { pauseMs: 0 })).toEqual([]);
  });

  it('classifies against the app limits (a share equal to the limit passes) and never treats unknown as over', () => {
    expect(classifyProbe(probe('a', MAX_CREATOR_HOLDING_PCT, MAX_TOP10_HOLDERS_PCT), limits)).toBe('CLEAR');
    expect(classifyProbe(probe('a', MAX_CREATOR_HOLDING_PCT + 0.1, 1), limits)).toBe('OVER');
    expect(classifyProbe(probe('a', 1, MAX_TOP10_HOLDERS_PCT + 0.1), limits)).toBe('OVER');
    expect(classifyProbe(probe('a', null, null), limits)).toBe('UNKNOWN');
    expect(classifyProbe(probe('a', 1, null), limits)).toBe('UNKNOWN');
    expect(classifyProbe(probe('a', 1, 1, false), limits)).toBe('UNUSABLE');
  });

  it('puts clear mints first; offers over-limit mints only with the waiver on, lowest creator share first; never unknown', () => {
    const ps = [probe('over17', 16.9, 10), probe('unk', null, null), probe('clear', 3, 10), probe('over14', 13.9, 10), probe('dead', 1, 1, false)];
    expect(orderCandidates(ps, limits, true).map((c) => `${c.mint}:${c.kind}`)).toEqual(['clear:CLEAR', 'over14:OVER', 'over17:OVER']);
    expect(orderCandidates(ps, limits, false).map((c) => c.mint)).toEqual(['clear']);
    expect(orderCandidates([probe('unk', null, null)], limits, true)).toEqual([]);
  });

  const reportFor = (over: Partial<Parameters<typeof EligibilityFilter.evaluate>[0]>) =>
    EligibilityFilter.evaluate(
      { mint: 'M', symbol: 'S', name: 'N', isMintAuthorityRevoked: true, isFreezeAuthorityRevoked: true, devHoldingPct: 2, top10HoldersPct: 10, liquidityUsd: 1_000_000, ...over },
      true
    );

  it('waives only a failed creator or top-10 check, says so in the reason, and leaves the app filter failing the same token', () => {
    const rpt = reportFor({ devHoldingPct: 16.9 });
    expect(rpt.isEligible).toBe(false); // the app's own filter still refuses it
    const w = waiveHolderChecks(rpt, 123)!;
    expect(w.waived).toHaveLength(1);
    expect(w.report.isEligible).toBe(true);
    expect(w.report.failedCount).toBe(0);
    expect(w.report.evaluatedAt).toBe(123);
    const c = w.report.checks.find((x) => x.ruleId === 'MAX_CREATOR_EXPOSURE')!;
    expect(c.reason).toMatch(/WAIVED by the devnet harness only/);
    expect(c.observedValue).toBe('16.9%'); // the real value is kept
    expect(reportFor({ devHoldingPct: 16.9 }).isEligible).toBe(false);
  });

  it('refuses to waive when anything else failed, or a holder share is unknown', () => {
    expect(waiveHolderChecks(reportFor({ devHoldingPct: 16.9, isFreezeAuthorityRevoked: false }))).toBeNull();
    expect(waiveHolderChecks(reportFor({ devHoldingPct: null }))).toBeNull();
    expect(waiveHolderChecks(reportFor({ devHoldingPct: 16.9, top10HoldersPct: null }))).toBeNull();
  });

  it('builds the eligibility input exactly as the coordinator does', () => {
    const state: any = createSimulatedBondingCurveState();
    const req = { mint: 'M', symbol: 'E2E', name: 'E2E' };
    const dist = { devHoldingPct: 3, top10HoldersPct: 9 };
    const theirs = (ExecutionCoordinator.prototype as any).eligibilityInputFromMarket.call({}, req, state, dist, 1234);
    expect(harnessEligibilityInput(req, state, dist, 1234)).toEqual(theirs);
    expect(harnessEligibilityInput(req, state, null, undefined)).toEqual((ExecutionCoordinator.prototype as any).eligibilityInputFromMarket.call({}, req, state, null, undefined));
  });

  it('liveBuyRequest carries a supplied report', () => {
    const rpt = reportFor({});
    expect(liveBuyRequest('M', 0.01, 5, rpt).eligibilityReport).toBe(rpt);
    expect(liveBuyRequest('M', 0.01, 5)).not.toHaveProperty('eligibilityReport');
  });

  it('never prints an RPC URL: scrubUrls, the guard log, and no harness line logs the URL variable', () => {
    expect(scrubUrls('failed https://dev.quiknode.pro/abc123secret/?k=v and wss://h.example/key done')).toBe('failed <url> and <url> done');
    const guard = path.resolve(process.cwd(), 'scripts/devnet_guard.cjs');
    const r = spawnSync(process.execPath, ['--require', guard, '-e', "fetch('http://127.0.0.1:9/abc123secret?token=zzz').catch(()=>{})"], { encoding: 'utf8', timeout: 20_000 });
    expect(r.stderr).toContain('http://127.0.0.1:9');
    expect(r.stderr).not.toContain('abc123secret');
    expect(r.stderr).not.toContain('zzz');
    const src = fs.readFileSync('scripts/devnet_e2e.ts', 'utf8');
    for (const line of src.split('\n')) if (/console\.(log|error)/.test(line)) expect(line).not.toMatch(/RPC_URL|DEVNET_RPC/);
    expect(src).toMatch(/DEVNET_NO_WAIVER/);
    expect(src).toMatch(/selected-mint\.json/); // the crash and recover processes reuse the mint the main process chose
  });
});
