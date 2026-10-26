import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import BN from 'bn.js';
import { PublicKey, Keypair } from '@solana/web3.js';
import * as sdk from '@pump-fun/pump-sdk';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

/**
 * 5A: one cost and latency model for the in-app replay and the offline studies (server/backtest/costModel.ts), and the buy quote's fee split.
 * Every block here fails on 767c13a without its commit.
 */

const PUMP: any = (sdk as any).PUMP_SDK ?? (sdk as any).default?.PUMP_SDK;
const dump = (name: string) => {
  const j = JSON.parse(fs.readFileSync(`scripts/localnet/accounts/${name}.json`, 'utf8'));
  return { data: Buffer.from(j.account.data[0], 'base64'), owner: new PublicKey(j.account.owner), lamports: 1, executable: false } as any;
};

describe('5A (N-41): the buy quote charges the fee on the curve input, split by bps with ceil as the SDK does', () => {
  let savedGlobal: any;
  let savedFee: any;
  beforeEach(() => {
    savedGlobal = PumpCurveService.cachedGlobal;
    savedFee = (PumpCurveService as any).cachedFeeConfig;
    PumpCurveService.cachedGlobal = PUMP.decodeGlobal(dump('pump_global'));
    (PumpCurveService as any).cachedFeeConfig = PUMP.decodeFeeConfig(dump('pump_fee_config'));
  });
  afterEach(() => {
    PumpCurveService.cachedGlobal = savedGlobal;
    (PumpCurveService as any).cachedFeeConfig = savedFee;
  });

  // the audit's fixture: vS 30 SOL, vT 1.073e15, 95 + 30 bps, a 0.1 SOL buy
  const state = createSimulatedBondingCurveState({
    creator: Keypair.generate().publicKey,
    virtualSolReserves: 30_000_000_000n,
    virtualTokenReserves: 1_073_000_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    realSolReserves: 0n,
    protocolFeeBps: 95,
    creatorFeeBps: 30,
  });
  const sdkBuyCost = (tokens: bigint, feeConfig: any) => BigInt(sdk.getBuySolAmountFromTokenAmount({
    global: { ...PumpCurveService.cachedGlobal, tokenTotalSupply: new BN(state.tokenTotalSupply.toString()), creatorFeeConfigurable: false } as any,
    feeConfig,
    mintSupply: new BN(state.tokenTotalSupply.toString()),
    bondingCurve: {
      virtualTokenReserves: new BN(state.virtualTokenReserves.toString()), virtualQuoteReserves: new BN(state.virtualSolReserves.toString()),
      realTokenReserves: new BN(state.realTokenReserves.toString()), realQuoteReserves: new BN(state.realSolReserves.toString()),
      tokenTotalSupply: new BN(state.tokenTotalSupply.toString()), complete: false, quoteMint: state.quoteMint,
      creatorFeeBps: new BN(30), creator: state.creator, isMayhemMode: false, isCashbackCoin: false, canEditCreatorFee: false,
    } as any,
    amount: new BN(tokens.toString()),
  } as any).toString());
  const zero = { lpFeeBps: new BN(0), protocolFeeBps: new BN(0), creatorFeeBps: new BN(0) };
  const noFees = { feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: zero }], stableFeeTiers: [], flatFees: zero, exoticFlatFees: zero };

  it('protocol + creator fee equals the SDK cost of the tokens minus their curve cost (LIVE and PAPER)', () => {
    for (const executionMode of ['LIVE', 'PAPER'] as const) {
      const q = PumpCurveService.calculateBuyQuote({ state, amountSol: 0.1, executionMode, slippageBps: 300 } as any);
      const tokens = BigInt(q.tokenAmountRaw);
      const fee = sdkBuyCost(tokens, (PumpCurveService as any).cachedFeeConfig) - sdkBuyCost(tokens, noFees);
      expect(BigInt(q.protocolFeeLamports + q.creatorFeeLamports)).toBe(fee);
      // and the split: what the program pays the protocol and the creator, each rounded up
      expect(q.protocolFeeLamports).toBe(938_272);
      expect(q.creatorFeeLamports).toBe(296_297);
    }
  });
});

// ---- the replay on the shared cost and latency model ----------------------------------------------------------------------------------
import { replayLaunch, replayLaunches, replayCostCase, REPLAY_DEFAULTS, type ReplayOptions } from '../server/backtest/replay';
import { simulatePath, priceEntryParts, restoreStockEngine, STOCK_VARIANT, type TradeRow } from '../server/backtest/costModel';
import { toRecordedLaunch, type CorpusLaunch } from '../scripts/hfcorpus/replay';
import { WATCH_MAX_MS } from '../server/signals/watchWindow';

const T0 = 1_760_000_000_000;
/** steady distinct-buyer buying (the same curve maths as the chain's reserves) that the watch window releases at threshold 0 */
function warmUp(t0 = T0): TradeRow[] {
  let vSol = 30e9, vTok = 1.073e15;
  const rows: TradeRow[] = [];
  for (let i = 0; i < 60; i++) {
    const sol = 0.3 + (i % 5) * 0.2, k = vSol * vTok, newS = vSol + sol * 1e9, newT = k / newS;
    rows.push([t0 + 1500 + i * 900, true, sol, (vTok - newT) / 1e6, 'w' + (i % 40), Math.round(newS), Math.round(newT), `w-${i}`]);
    vSol = newS; vTok = newT;
  }
  return rows;
}
const launch = (rows: TradeRow[], t0 = T0): CorpusLaunch => ({ mint: 'Mint5A', symbol: 'FA', creator: 'creator5A', mayhem: false, t0, graduated: false, trades: rows });
const GATE: ReplayOptions = { minScore: 0, readyGate: false, curveCap: false };
/** the warm-up cut at its release, so everything after the release is the scripted path; returns the release time and the last state */
function released(): { rows: TradeRow[]; releaseTs: number; at: (dtMs: number, multiple: number) => TradeRow } {
  const full = warmUp();
  const r = replayLaunch(toRecordedLaunch(launch(full), 150), [], 150, GATE);
  expect(r.releasedAfterMs).not.toBeNull();
  const releaseTs = T0 + (r.releasedAfterMs as number);
  const rows = full.filter((x) => x[0] <= releaseTs);
  const [, , , , , vS, vT] = rows[rows.length - 1];
  // a print at price multiple m of the entry state, on the same constant product
  const at = (dtMs: number, m: number): TradeRow => [releaseTs + dtMs, true, 0.1, 1, 'later', Math.round(vS * Math.sqrt(m)), Math.round(vT / Math.sqrt(m)), `p-${dtMs}`];
  return { rows, releaseTs, at };
}
const replay = (rows: TradeRow[], o: ReplayOptions = {}) => replayLaunch(toRecordedLaunch(launch(rows), 150), [], 150, { ...GATE, ...o });
/** no fee, no impact, no transaction cost: only the price path moves the money */
const FREE: ReplayOptions = { feePct: 0, impact: false, networkFeeSol: 0, priorityBuySol: 0, prioritySellSol: 0, tipSol: 0 };

describe('5A replay: fills, exits and money from the shared model', () => {
  afterEach(() => restoreStockEngine());

  it('a launch with no print after the release is still bought, at the curve state when the buy lands', () => {
    const { rows, releaseTs } = released();
    const r = replay(rows);
    expect(r.entered).toBe(true);
    expect(r.outcome).toBe('OPEN_AT_END');
    expect(r.entryPriceSol).toBeCloseTo(rows[rows.length - 1][5] / rows[rows.length - 1][6] / 1000, 15);
    expect(r.releasedAfterMs).toBe(releaseTs - T0);
  });

  it('a flat round trip closed by the stale exit at entry + 30 min costs the fee on both legs and one fixed cost per transaction', () => {
    const { rows } = released();
    const f = REPLAY_DEFAULTS.feePct / 100, order = REPLAY_DEFAULTS.orderSol, fixed = 0.000005 + 0.00001 + 0.0001;
    // recorded for 40 min after create: the curve did not move after the last print, so the stale sell fills at it
    const r = replay(rows, { impact: false, networkFeeSol: 0.000005, priorityBuySol: 0.00001, prioritySellSol: 0.00001, tipSol: 0.0001, recordedForMs: 40 * 60_000 });
    expect(r.outcome).toBe('CLOSED');
    expect(r.exits).toEqual([expect.objectContaining({ reason: 'STALE_POSITION', sellPct: 100, afterMs: 1_800_000 + REPLAY_DEFAULTS.exitDelayMs })]);
    expect(r.transactions).toBe(2);
    // the SDK's buy: order / (1 + f) goes into the curve; the sell pays f on the proceeds
    expect(r.netPnlSol).toBeCloseTo(-(order * (1 - (1 - f) / (1 + f))) - 2 * fixed, 12);
  });

  it('TP1, TP2 and the trailing stop are four transactions, each paying the fixed cost', () => {
    const { rows, at } = released();
    const path = [...rows, at(4_000, 1.35), at(10_000, 1.35), at(16_000, 1.7), at(22_000, 1.7), at(28_000, 1.2), at(34_000, 1.2)];
    const free = replay(path, FREE);
    const paid = replay(path, { ...FREE, networkFeeSol: 0.0002 });
    expect(free.exits.map((e) => e.reason)).toEqual(['TAKE_PROFIT_1', 'TAKE_PROFIT_2', 'TRAILING_STOP']);
    expect(paid.transactions).toBe(4);
    expect((free.netPnlSol as number) - (paid.netPnlSol as number)).toBeCloseTo(4 * 0.0002, 12);
  });

  it('OPEN_AT_END keeps the take-profit proceeds: realized and open are reported apart, and the open part is charged its sell', () => {
    const { rows, at } = released();
    const path = [...rows, at(4_000, 1.35), at(10_000, 1.35), at(16_000, 1.7), at(22_000, 1.7)];
    const r = replay(path, FREE);
    expect(r.outcome).toBe('OPEN_AT_END');
    expect(r.exits.map((e) => e.reason)).toEqual(['TAKE_PROFIT_1', 'TAKE_PROFIT_2']);
    expect(r.netPnlSol).toBeNull();
    expect(r.realizedProceedsSol).toBeGreaterThan(0);
    expect(r.openNetPnlSol).toBeCloseTo((r.realizedProceedsSol as number) + (r.openValueSol as number) - REPLAY_DEFAULTS.orderSol, 12);
    const charged = replay(path, { ...FREE, networkFeeSol: 0.0002 });
    expect(charged.transactions).toBe(4); // buy, two sells, and the sell the open mark assumes
    expect((r.openValueSol as number) - (charged.openValueSol as number)).toBeCloseTo(0.0002, 12);
    const rep = replayLaunches([toRecordedLaunch(launch(path), 150)], [], 150, { ...GATE, ...FREE });
    expect(rep.summary.netPnlSol).toBeNull(); // no closed trade
    expect(rep.summary.openMarkNetPnlSol).toBeCloseTo(r.openNetPnlSol as number, 12);
  });

  it('a +35% print that reverts within 1 s does not take TP1: the engine looks every 3 s', () => {
    const { rows, at } = released();
    // the buy lands at +1.5 s, so the engine polls at +4.5 s, +7.5 s, ...; the spike lives from +5.0 s to +5.8 s
    const r = replay([...rows, at(5_000, 1.35), at(5_800, 1.0), at(60_000, 1.0)], FREE);
    expect(r.exits).toEqual([]);
    expect(r.outcome).toBe('OPEN_AT_END');
  });

  it('a launch whose first trade comes late still gets its verdict: the fallback runs to first trade + WATCH_MAX_MS', () => {
    // a few buys from create + 20 s to create + 60 s, then silence: the window waits to its maximum
    const rows = warmUp().slice(0, 5).map((x, i): TradeRow => [T0 + 20_000 + i * 10_000, x[1], x[2], x[3], x[4], x[5], x[6], x[7]]);
    const r = replay(rows);
    expect(r.verdict).not.toBe('NO_TRADES');
    expect(r.releasedAfterMs).toBeGreaterThan(125_000);
    expect(r.releasedAfterMs).toBeLessThanOrEqual(20_000 + WATCH_MAX_MS + REPLAY_DEFAULTS.tickMs);
  });

  it('the replay and the studies price a position the same way (closed and open)', () => {
    const { rows, at, releaseTs } = released();
    for (const path of [[...rows, at(4_000, 1.35), at(10_000, 1.35), at(16_000, 0.5), at(20_000, 0.5)], [...rows, at(4_000, 1.35), at(10_000, 1.35)]]) {
      const r = replay(path);
      const p = simulatePath(path, releaseTs, { entryMs: REPLAY_DEFAULTS.entryDelayMs, exitMs: REPLAY_DEFAULTS.exitDelayMs }, STOCK_VARIANT)!;
      const m = priceEntryParts(path, p, REPLAY_DEFAULTS.orderSol, replayCostCase(REPLAY_DEFAULTS));
      expect(r.outcome === 'CLOSED' ? r.netPnlSol : r.openNetPnlSol).toBeCloseTo(m.netSol, 12);
    }
  });

  it('the report says which gaps are optimistic and names exit latency and the fee', () => {
    const rep = replayLaunches([], [], 150);
    expect(rep.notReplayedByDirection.optimistic.length).toBeGreaterThan(0);
    expect(rep.notReplayedByDirection.pessimistic.length).toBeGreaterThan(0);
    const all = rep.notReplayed.join(' ');
    expect(all).toMatch(/exit latency|exit delay/i);
    expect(rep.rules.join(' ')).toMatch(/fee on the buy and on every sell/);
  });
});

// ---- the studies: realized and open apart, open marks never pick the setting ----------------------------------------------------------
import { runStudy, keyIndex, type StudyOptions } from '../scripts/hfcorpus/ev_study';

describe('5A studies (R1-100): open marks are reported apart and never pick the best setting on train', () => {
  afterEach(() => restoreStockEngine());
  it('a +25% open mark does not beat a take-profit that banked part of it', async () => {
    const { rows, at } = released();
    // +25% four seconds after the release, then the data ends: TP1 at +15% sells a third, TP1 at +30% sells nothing; both end open
    const path = [...rows, at(4_000, 1.25), at(60_000, 1.25)];
    const o: StudyOptions = { thresholds: [0], sizes: [0.01], splitTs: T0 + 1, solUsd: 150, minTrainEntries: 1, bootstrapResamples: 10, seed: 1 };
    const { report, totals } = await runStudy({ launches: [{ rec: toRecordedLaunch(launch(path), 150), t0: T0, trades: path }], firstDay: 0, lastDay: 30_000, options: o, source: 'fixture', note: 'n', splitNote: 's' });
    const s = report.scenarios.find((x) => x.latency === '1.5s/1.5s' && x.cost === 'rpc_1.25')!;
    expect(s.chosen!.variant).toMatch(/tp15/);
    expect(s.chosen!.train.openEntries).toBe(1);
    // on the raw marked EV (open gains included) a tp30 variant would have been chosen: the cap is what changed the pick
    const d = totals.dims, li = d.lat.findIndex((l) => l.entryMs === 1500 && l.exitMs === 1500), ci = d.costs.findIndex((c) => c.name === 'rpc_1.25');
    const raw = d.variants.map((v, vi) => ({ v, ev: totals.sum[0][keyIndex(d, 0, li, vi, 0, ci)] }));
    expect(raw.reduce((a, b) => (b.ev > a.ev ? b : a)).v.tp1).toBe(30);
  });
});
