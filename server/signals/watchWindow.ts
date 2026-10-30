import { EventEmitter } from 'events';
import { watchMaxCandidates } from './capacity';
import { CONFLUENCE_DEFAULT_THRESHOLD, getConfluenceThreshold } from './confluenceThreshold';
import { isCurveTooFar, curveTooFarReason } from './curveProgressCap';
import type { PumpTradeEvent } from '../solana/pumpFeedListener';

/**
 * G2: the watch window. A new token is held for 20-120s from its FIRST trade while real TradeEvents build up the
 * evidence a snapshot cannot give: who is buying, how concentrated it is, whether the creator is selling.
 *
 * Pure bookkeeping over TradeEvents with an injected clock, so every metric is replayable from fixtures.
 * Nothing here trades: a release is information for the auto controller and the board.
 *
 * The creator cluster (the creator, the create signer, and every wallet the creator funded) is not demand: its trades are left out of
 * velocity, flow and net inflow (P4.1, R1-55), and a sell by any wallet in it is CREATOR_SOLD. It still counts in concentration.
 * R2-1: "funded" is any SOL source the funder lookup found in the wallet's history (FunderLookup reads a short history in full), not only the first.
 *
 * R8-2: every buyer count is a count of clusters: wallets joined through any shared SOL source (a union over wallet -> source links,
 * allowlisted public funders left out). A wallet whose history was not read in full (`verified: false`, or no funder found at all) is not an
 * independent buyer: all such wallets together count as one in uniqueBuyers. Velocity counts each cluster's net inflow up to
 * VELOCITY_MAX_SOL_PER_WALLET_30S and needs VELOCITY_MIN_DISTINCT_WALLETS clusters buying; flow compares buying and selling clusters, not trades.
 *
 * Release states:
 *   DEAD   cumulative organic net inflow negative once the minimum hold has passed, or ANY creator-cluster sell (instant; also when the
 *          funder that puts a wallet that already sold into the creator cluster arrives later), or (P4.3) the measured curve progress is
 *          above the cap, 60% by default (CURVE_TOO_FAR, at any evaluation after the first trade, see curveProgressCap.ts)
 *   HOT    minimum hold passed, >= 3 measured signals strong, and the confluence score is at or above the threshold in force (default 70)
 *
 * B3 (review 2026-10-24, finding 3, second half): when a funder lookup is wired, every seller whose funder is not known is looked up
 * (ahead of buyer lookups, outside the buyer sample), and no HOT or READY verdict is given while that lookup is outstanding, because the
 * sell may be the creator cluster's (an answer in the creator cluster releases CREATOR_SOLD). A seller whose funder could not be read
 * (the lookup failed after its retries, or was refused), or whose lookup is still outstanding when the full window has elapsed, costs a
 * signal, not the launch, as an unreadable buyer does: it counts as an unknown funder in funderCoverage, so the buyers signal cannot pass,
 * and its sell stays in the organic flow (the pessimistic side for net inflow and flow). A lost Connection or a full queue therefore never
 * releases launches DEAD on its own.
 *   READY  the full window elapsed without a dead or hot verdict. P4.3 (R1-56): a READY release is information, not a buy signal by itself:
 *          the auto controller (and the replay) buy it only when `readyGate` passes (concentration and at least READY_MIN_SIGNALS signals)
 *          and its score clears the threshold.
 */
/** Q6c: was 10, which a busy feed fills with the first ten launches while the rest are refused without a trace. */
export const WATCH_MAX_CANDIDATES = 60;
export const WATCH_MIN_MS = 20_000;
export const WATCH_MAX_MS = 120_000;
export const WATCH_BUCKET_MS = 10_000;
export const HOT_MIN_VELOCITY_SOL_PER_MIN = 1.5;
export const HOT_MIN_UNIQUE_BUYERS = 25;
export const HOT_MAX_LARGEST_BUYER_SHARE = 0.15;
/** R8-2: velocity passes only when at least this many distinct clusters had a positive net inflow in the last 30 s. */
export const VELOCITY_MIN_DISTINCT_WALLETS = 5;
/** R8-2: one cluster's net inflow counts toward velocity up to this much SOL per 30 s window (a third of the 0.75 SOL a pass needs). */
export const VELOCITY_MAX_SOL_PER_WALLET_30S = 0.25;
/** R8-2: flow passes only with at least this many distinct buying clusters, and more of them than selling clusters. */
export const FLOW_MIN_DISTINCT_BUYERS = 5;
/**
 * P4.1 (R1-60): funder coverage is measured over the largest this-many buyers by buy volume, not over every raw buyer. A launch with more
 * buyers than the lookup will serve per mint (FUNDER_LOOKUP_MAX_PER_MINT, 150) could never reach coverage 1 before. The first this-many
 * buyers are looked up as they arrive; a later buyer whose volume moves it into the largest set is looked up at the next evaluation.
 */
export const WATCH_FUNDER_SAMPLE_BUYERS = 100;
/**
 * R13-4: the most second-hop lookups (the funder of a buyer's or seller's SOL source) asked for per watched mint, for the holder gate's
 * creator -> hop -> holder check (holderCluster.ts). A source past the bound is never looked up, so a holder funded by it reads UNKNOWN.
 * RPC cost: up to this many more lookups per launch, each at most FUNDER_FULL_HISTORY_MAX + 1 reads (an exchange wallet costs one).
 */
export const WATCH_FUNDER_HOP_MAX = 50;
/**
 * S4d: wallets that fund thousands of unrelated traders (exchange hot wallets, a faucet) and must not make their customers one cluster.
 * EXPLICIT only: an operator-supplied list in APEX_PUBLIC_FUNDERS (comma-separated addresses), empty by default. It is deliberately not
 * inferred from behaviour (for example "funds buyers of 5 mints"), because an attacker can fake any behaviour cheaply and so make their own
 * cluster vanish. No address is built in: I could not verify any here, and a wrong entry silently blinds the buyers signal.
 */
export function publicFundersFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.APEX_PUBLIC_FUNDERS ?? '').split(',').map((a) => a.trim()).filter(Boolean));
}
export const HOT_MIN_SIGNALS = 3;
/** P4.3 (R1-56): a READY release must still show this many strong signals (one fewer than HOT), concentration among them. */
export const READY_MIN_SIGNALS = HOT_MIN_SIGNALS - 1;
/** The built-in default; the gate itself reads the one shared threshold (S187), so HOT and the execution gate never diverge. */
export const HOT_MIN_SCORE = CONFLUENCE_DEFAULT_THRESHOLD;
const CREATOR_CLUSTER = 'cluster:creator';
/** R13-2: the one key every buyer that is not independent shares in velocity and flow (no funder known, none found, or a history not read in full). */
const UNATTRIBUTED_BUYERS = 'cluster:unattributed';
const MAX_FUNDERS_KEPT = 20_000;

export type WatchState = 'WATCHING' | 'HOT' | 'READY' | 'DEAD';

export interface WatchSignals {
  /** Organic net inflow (creator cluster left out) over the last 30s, scaled to SOL/min, and whether it beats the 30s before it. null before 20s of data.
   *  R8-2: `solPerMin` counts each cluster up to VELOCITY_MAX_SOL_PER_WALLET_30S (`rawSolPerMin` does not); `distinctWallets` is the clusters buying in the window. */
  velocity: { solPerMin: number; rawSolPerMin: number; distinctWallets: number; rising: boolean; pass: boolean } | null;
  /** De-clustered unique buyers; only passes when the funder of every buyer in the sample (the largest WATCH_FUNDER_SAMPLE_BUYERS by volume) is known. */
  buyers: { count: number; funderCoverage: number; pass: boolean } | null;
  /** Largest cluster's share of buy volume. */
  concentration: { share: number; pass: boolean } | null;
  /** Organic buys (creator cluster left out) outnumber organic sells. R8-2: counted in clusters (`buyWallets`, `sellWallets`), trades reported apart. */
  flow: { buyCount: number; sellCount: number; buyWallets: number; sellWallets: number; pass: boolean } | null;
}

export interface WatchMetrics {
  mint: string;
  creator: string | null;
  firstTradeAt: number | null;
  elapsedMs: number;
  tradeCount: number;
  /** Organic net SOL inflow (buys - sells, creator cluster left out) per 10s bucket from the first trade. */
  netInflowPer10s: number[];
  cumulativeNetInflowSol: number;
  /** P4.1: what the creator cluster bought and sold, reported apart from the organic flow above. */
  creatorClusterBuySol: number;
  creatorClusterSellSol: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  rawUniqueBuyers: number;
  /** Buyers after merging wallets with one funder, and everything the creator funded, into one. */
  uniqueBuyers: number;
  /** Share of the sampled buyers (the largest WATCH_FUNDER_SAMPLE_BUYERS by volume) whose funder is known. 0 when nothing is known.
   *  B3: a seller outside the sample whose funder lookup is outstanding or failed counts as one more unknown. */
  funderCoverage: number;
  /** Organic buy and sell counts (creator cluster left out). */
  buyCount: number;
  sellCount: number;
  /** buys / sells; null with no sells (never Infinity). */
  buySellRatio: number | null;
  /** Largest cluster's share of buy volume; null with no buys. */
  largestBuyerShare: number | null;
  creatorSold: boolean;
  signals: WatchSignals;
  passingSignals: number;
}

export interface WatchResult {
  state: WatchState;
  reason: string;
  metrics: WatchMetrics;
  score: number | null;
  releasedAt: number | null;
}

interface Candidate {
  mint: string;
  creator: string | null;
  /** Wallets whose sells mean the dev is out: the creator and, when different, the signer of the create (R14). */
  insiders: Set<string>;
  registeredAt: number;
  firstTradeAt: number | null;
  buyVolumeByWallet: Map<string, number>;
  sellVolumeSol: number;
  tradeCount: number;
  creatorSold: boolean;
  /** Every trade (ms seen, signed SOL, wallet). Flow, velocity and net inflow are computed from it at evaluation time, because a wallet
   *  can join the creator cluster after its trade, when its funder arrives. */
  flow: Array<{ at: number; sol: number; wallet: string; buy: boolean }>;
  /** Wallets that sold this mint: a funder arriving later can make one of them a creator-cluster seller. */
  sellers: Set<string>;
  /** B3: sellers whose funder lookup was asked for and has not answered yet, and sellers whose funder could not be read. */
  sellersPending: Set<string>;
  sellersUnreadable: Set<string>;
  /** R13-2: buyers whose funder lookup was asked for (and accepted) and has not answered yet. They hold HOT and READY, as pending sellers do. */
  buyersPending: Set<string>;
  /** Wallets whose funder was asked for on this mint's behalf. */
  requested: Set<string>;
  /** R13-4: SOL sources of those wallets whose own funder was asked for (the second hop), at most WATCH_FUNDER_HOP_MAX. */
  hopRequested: Set<string>;
  seen: Set<string>;
}

export interface WatchWindowOptions {
  maxCandidates?: number;
  minMs?: number;
  maxMs?: number;
  /** Funder of a wallet (first incoming transfer), or null when unknown. Fixtures in tests; no network lookup is built in. */
  funderOf?: (wallet: string) => string | null | undefined;
  /** Confluence score for a mint, or null when it cannot be scored. HOT needs a score of at least the threshold in force (default 70). */
  scoreOf?: (mint: string) => number | null | undefined;
  /** S4d: funders whose wallets are not clustered together (see publicFundersFromEnv). Default: the environment's list. */
  publicFunders?: Iterable<string>;
  /** S187: a fixed HOT score for this window (what-if replay). Default: the shared threshold in force, read at each evaluation. */
  minScore?: number;
  /** P4.3 (R1-57): measured curve progress (0..100, tokens sold) of a mint, or null when unknown. Above the cap the launch is released DEAD CURVE_TOO_FAR. */
  progressOf?: (mint: string) => number | null | undefined;
}

/**
 * P4.3 (R1-56): what a READY release must still show to be bought: concentration passing and at least READY_MIN_SIGNALS strong signals. A launch whose
 * window ran out with one funder group behind most of the volume, or with a single passing signal, is not bought on its score alone.
 */
export function readyGate(m: Pick<WatchMetrics, 'passingSignals' | 'signals'>): { pass: boolean; reason: string } {
  const conc = m.signals.concentration;
  const concText = conc === null ? 'no buys' : `largest cluster ${(conc.share * 100).toFixed(1)}% of buy volume (limit ${HOT_MAX_LARGEST_BUYER_SHARE * 100}%)`;
  if (!conc?.pass) return { pass: false, reason: `READY_TOO_WEAK: concentration fails (${concText}), ${m.passingSignals} strong signal(s)` };
  if (m.passingSignals < READY_MIN_SIGNALS) return { pass: false, reason: `READY_TOO_WEAK: ${m.passingSignals} strong signal(s), a READY release needs ${READY_MIN_SIGNALS}` };
  return { pass: true, reason: `READY with ${m.passingSignals} strong signals, concentration passing` };
}

/** What `getVerdict` reports. P4.3: a released mint also carries its release metrics' signal count and concentration (additive fields). */
export interface WatchVerdict {
  state: WatchState;
  reason: string;
  releasedAt?: number;
  score?: number | null;
  passingSignals?: number;
  concentrationPass?: boolean | null;
  /** The release-time metrics; absent while WATCHING. */
  metrics?: WatchMetrics;
}

export class WatchWindow extends EventEmitter {
  private active = new Map<string, Candidate>();
  private released = new Map<string, WatchResult>();
  private opts: Required<Pick<WatchWindowOptions, 'maxCandidates' | 'minMs' | 'maxMs'>> & Pick<WatchWindowOptions, 'funderOf' | 'scoreOf' | 'minScore' | 'progressOf'>;
  private funders = new Map<string, string>();
  /** R2-1: the other SOL sources the lookup found for a wallet (besides `funders`). */
  private alsoFundedBy = new Map<string, string[]>();
  /** R2-1: wallets whose history was not read in full: their funder is known but they are not independent buyers. */
  private unverified = new Set<string>();
  private publicFunders: Set<string>;
  /** Wallets whose funder was looked up and does not exist / is out of reach: they count as known, in a cluster of their own. */
  private noFunder = new Set<string>();
  private requestFunder: ((wallet: string, mint: string, priority?: boolean, hop?: boolean) => boolean | void) | null = null;
  /** Q6c: launches that were not watched because the window was full. */
  private refusedFull = 0;
  private lastRefusedMint: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** B3b: seller funder lookups asked for, those that failed or were refused, and sellers still pending when a launch reached its window end. */
  private sellerFunderStats = { asked: 0, unreadable: 0, pendingAtWindowEnd: 0 };

  constructor(opts: WatchWindowOptions = {}) {
    super();
    this.publicFunders = new Set(opts.publicFunders ?? publicFundersFromEnv());
    this.opts = {
      maxCandidates: opts.maxCandidates ?? watchMaxCandidates(),
      minMs: opts.minMs ?? WATCH_MIN_MS,
      maxMs: opts.maxMs ?? WATCH_MAX_MS,
      minScore: opts.minScore,
      funderOf: opts.funderOf,
      scoreOf: opts.scoreOf,
      progressOf: opts.progressOf,
    };
  }

  /**
   * Record a wallet's funder (the sender of its earliest incoming transfer). P4.1: when that puts a wallet that already sold a watched
   * mint into the mint's creator cluster, the mint is released DEAD CREATOR_SOLD now (the sell came before its funder was known).
   * R2-1: `alsoFundedBy` are the other SOL sources found in its history (any of them can put it in the creator cluster); `verified` false
   * (its history was longer than the lookup reads in full) keeps it out of the independent buyers. Default: verified, no other source.
   */
  public setFunder(wallet: string, funder: string, at = Date.now(), opts: { alsoFundedBy?: string[]; verified?: boolean } = {}): void {
    const also = (opts.alsoFundedBy ?? []).filter((x) => x && x !== funder && x !== wallet);
    const verified = opts.verified !== false;
    this.emit('funder', { wallet, funder, alsoFundedBy: also, verified });
    this.funders.set(wallet, funder);
    if (this.funders.size > MAX_FUNDERS_KEPT) this.funders.delete(this.funders.keys().next().value as string);
    if (also.length) this.alsoFundedBy.set(wallet, also); else this.alsoFundedBy.delete(wallet);
    if (this.alsoFundedBy.size > MAX_FUNDERS_KEPT) this.alsoFundedBy.delete(this.alsoFundedBy.keys().next().value as string);
    if (verified) this.unverified.delete(wallet); else this.unverified.add(wallet);
    if (this.unverified.size > MAX_FUNDERS_KEPT) this.unverified.delete(this.unverified.values().next().value as string);
    this.sellerAnswered(wallet);
    for (const c of [...this.active.values()]) {
      if (!c.creatorSold && c.sellers.has(wallet) && this.inCreatorCluster(c, wallet)) this.releaseCreatorSold(c, wallet, at);
    }
    this.askHops(wallet);
  }

  /**
   * R13-4: a wallet looked up for a watched mint has its sources' own funders asked for too (one more hop, never further), so the holder
   * gate can see creator -> hop -> holder. Bounded per mint by WATCH_FUNDER_HOP_MAX; a public funder, an insider, and a wallet already
   * known or asked for are skipped.
   */
  private askHops(wallet: string): void {
    if (!this.requestFunder) return;
    for (const c of this.active.values()) {
      if (!c.requested.has(wallet)) continue; // a hop's own answer does not start a third hop
      for (const s of this.sourcesOf(wallet)) {
        if (c.hopRequested.size >= WATCH_FUNDER_HOP_MAX) break;
        if (this.publicFunders.has(s) || c.insiders.has(s) || c.requested.has(s) || c.hopRequested.has(s) || this.funderFacts(s) !== null) continue;
        c.hopRequested.add(s);
        this.requestFunder(s, c.mint, false, true);
      }
    }
  }

  /** S4d: an allowlisted public funder; the holder gate does not trace its funding (holderCluster.ts). */
  public isPublicFunder(wallet: string): boolean {
    return this.publicFunders.has(wallet);
  }

  /**
   * R2-3: what the window knows of a wallet's funding, for the holder gate (server/signals/holderCluster.ts). null: never looked up.
   * `verified` is true only when its whole short history was read and a source was found.
   */
  public funderFacts(wallet: string): { sources: string[]; verified: boolean } | null {
    const sources = this.sourcesOf(wallet);
    if (sources.length > 0) return { sources, verified: !this.unverified.has(wallet) };
    if (this.noFunder.has(wallet)) return { sources: [], verified: false };
    return null;
  }

  private releaseCreatorSold(c: Candidate, wallet: string, at: number): void {
    c.creatorSold = true;
    const who = c.insiders.has(wallet) ? 'the creator sold' : `a wallet the creator funded (${wallet.slice(0, 6)}) sold`;
    this.release(c, 'DEAD', `CREATOR_SOLD: ${who}, instant reject`, at);
  }

  /** Q6b: record that a wallet's funder was looked up and there is none to cluster it with. R2-1: it counts as known, but not as an independent buyer. */
  public setNoFunder(wallet: string): void {
    this.emit('funder', { wallet, funder: null });
    this.noFunder.add(wallet);
    if (this.noFunder.size > MAX_FUNDERS_KEPT) this.noFunder.delete(this.noFunder.values().next().value as string);
    this.sellerAnswered(wallet);
  }

  /** B3: a wallet's funder lookup failed for good (after its retries). A watched launch it sold loses the buyers signal (funderCoverage < 1). */
  public setFunderUnreadable(wallet: string): void {
    for (const c of this.active.values()) {
      if (c.sellersPending.delete(wallet)) { c.sellersUnreadable.add(wallet); this.sellerFunderStats.unreadable++; }
      c.buyersPending.delete(wallet); // R13-2: it stays an unknown funder (unattributed in velocity and flow, coverage below 1)
    }
  }

  private sellerAnswered(wallet: string): void {
    for (const c of this.active.values()) {
      c.sellersPending.delete(wallet);
      c.sellersUnreadable.delete(wallet);
      c.buyersPending.delete(wallet);
    }
  }

  /**
   * Q6b: ask this function for the funder of every new buyer, and (B3) of every seller whose funder is not known, with `priority` true.
   * R13-4: and of those wallets' SOL sources (the second hop), with `hop` true.
   * The answer comes back through setFunder / setNoFunder (setFunderUnreadable when it failed); a `false` return means it was refused.
   */
  public setFunderRequester(fn: ((wallet: string, mint: string, priority?: boolean, hop?: boolean) => boolean | void) | null): void {
    this.requestFunder = fn;
  }

  public setScoreFn(fn: WatchWindowOptions['scoreOf']): void {
    this.opts.scoreOf = fn;
  }

  /** P4.3: the measured curve progress of a mint (server.ts wires onChainPoolStats). Null: not wired or not known. */
  public setCurveProgressFn(fn: WatchWindowOptions['progressOf']): void {
    this.opts.progressOf = fn;
  }

  /** P4.3: the measured curve progress the window sees for a mint now, or null. */
  public curveProgressPct(mint: string): number | null {
    const p = this.opts.progressOf?.(mint);
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  }

  private funderFor(wallet: string): string | null {
    return this.funders.get(wallet) ?? this.opts.funderOf?.(wallet) ?? null;
  }

  /** R2-1: every SOL source known for a wallet: its first funder, then the others the lookup found. */
  private sourcesOf(wallet: string): string[] {
    const f = this.funderFor(wallet);
    if (!f) return [];
    const also = this.alsoFundedBy.get(wallet);
    return also ? [f, ...also] : [f];
  }

  /** R2-1: an insider, or a wallet any of whose known SOL sources is an insider. */
  private inCreatorCluster(c: Candidate, wallet: string): boolean {
    if (c.insiders.has(wallet)) return true;
    for (const s of this.sourcesOf(wallet)) if (c.insiders.has(s)) return true;
    return false;
  }

  /** R2-1 / R8-2: an independent buyer: a funder found and its whole short history read (not `unverified`, not a no-funder wallet). */
  private isVerified(wallet: string): boolean {
    return !!this.funderFor(wallet) && !this.unverified.has(wallet);
  }

  /** Start watching a mint. False when the window is full or the mint is already watched/released. */
  public watch(mint: string, creator: string | null, now = Date.now(), alsoInsiders: Array<string | undefined> = []): boolean {
    if (this.active.has(mint) || this.released.has(mint)) return false;
    if (this.active.size >= this.opts.maxCandidates) {
      this.refusedFull++;
      this.lastRefusedMint = mint;
      this.emit('refused', { mint, active: this.active.size, max: this.opts.maxCandidates, refusedFull: this.refusedFull });
      return false;
    }
    this.active.set(mint, {
      mint, creator, insiders: new Set([creator, ...alsoInsiders].filter((w): w is string => !!w)), registeredAt: now, firstTradeAt: null, buyVolumeByWallet: new Map(),
      sellVolumeSol: 0, tradeCount: 0, creatorSold: false, flow: [], sellers: new Set(), sellersPending: new Set(), sellersUnreadable: new Set(),
      buyersPending: new Set(), requested: new Set(), hopRequested: new Set(), seen: new Set(),
    });
    return true;
  }

  public isWatching(mint: string): boolean {
    return this.active.has(mint);
  }

  /** P4.1: true while any watched mint was launched by this creator (its creator report is pinned for that long, see watchPins.ts). */
  public isWatchingCreator(creator: string): boolean {
    for (const c of this.active.values()) if (c.creator === creator) return true;
    return false;
  }

  private funderKnown(c: Candidate, wallet: string): boolean {
    return !!this.funderFor(wallet) || this.noFunder.has(wallet) || c.insiders.has(wallet);
  }

  private askFunder(c: Candidate, wallet: string): void {
    if (c.requested.has(wallet) || this.funderKnown(c, wallet)) return;
    c.requested.add(wallet);
    if (!this.requestFunder) return;
    // R13-2: an accepted lookup is pending until it answers (setFunder / setNoFunder) or fails for good (setFunderUnreadable). A cached
    // answer arrives inside this call, so the wallet is marked pending first and the answer clears it.
    c.buyersPending.add(wallet);
    if (this.requestFunder(wallet, c.mint) === false) c.buyersPending.delete(wallet);
  }

  /**
   * B3: a seller outside the buyer sample, or one whose lookup was refused or failed, is asked for again, ahead of buyers. setFunder
   * releases CREATOR_SOLD when the answer puts it in the creator cluster. Without a lookup wired (replay, fixtures) nothing is pending.
   */
  private askSellerFunder(c: Candidate, wallet: string): void {
    if (!this.requestFunder || c.sellersPending.has(wallet)) return;
    c.requested.add(wallet);
    c.sellersUnreadable.delete(wallet);
    c.sellersPending.add(wallet);
    this.sellerFunderStats.asked++;
    const accepted = this.requestFunder(wallet, c.mint, true);
    if (accepted === false && c.sellersPending.delete(wallet)) { c.sellersUnreadable.add(wallet); this.sellerFunderStats.unreadable++; }
  }

  /** Feed one decoded TradeEvent. `at` is when it was seen (ms). Duplicate signatures are ignored. */
  public onTrade(trade: PumpTradeEvent, at = Date.now()): void {
    const c = this.active.get(trade.mint);
    if (!c) return;
    const key = `${trade.signature}:${trade.user}:${trade.isBuy ? 'b' : 's'}`;
    if (c.seen.has(key)) return;
    c.seen.add(key);

    const sol = Number(trade.solAmountLamports) / 1e9;
    if (c.firstTradeAt === null) c.firstTradeAt = at;
    c.tradeCount++;
    c.flow.push({ at, sol: trade.isBuy ? sol : -sol, wallet: trade.user, buy: trade.isBuy });

    if (trade.isBuy) {
      // The first WATCH_FUNDER_SAMPLE_BUYERS buyers are looked up at once; later ones only if they become one of the largest (evaluate).
      if (!c.buyVolumeByWallet.has(trade.user) && c.requested.size < WATCH_FUNDER_SAMPLE_BUYERS) this.askFunder(c, trade.user);
      c.buyVolumeByWallet.set(trade.user, (c.buyVolumeByWallet.get(trade.user) ?? 0) + sol);
    } else {
      c.sellVolumeSol += sol;
      c.sellers.add(trade.user);
      // P4.1 (R1-55): any creator-cluster wallet, not only the literal creator and create signer
      if (!c.creatorSold && this.inCreatorCluster(c, trade.user)) this.releaseCreatorSold(c, trade.user, at);
      else if (!this.funderKnown(c, trade.user)) this.askSellerFunder(c, trade.user);
    }
  }

  /** The largest WATCH_FUNDER_SAMPLE_BUYERS buyers by buy volume (ties: first buyer first). */
  private fundersSample(c: Candidate): string[] {
    const all = [...c.buyVolumeByWallet.entries()];
    if (all.length <= WATCH_FUNDER_SAMPLE_BUYERS) return all.map(([w]) => w);
    return all.sort((a, b) => b[1] - a[1]).slice(0, WATCH_FUNDER_SAMPLE_BUYERS).map(([w]) => w);
  }

  /**
   * R8-2: the cluster key of every wallet that traded this mint: CREATOR_CLUSTER for the creator cluster, else the root of a union over
   * wallet -> SOL source links (any shared source joins two wallets, and a funder that buys joins the wallets it funded). S4d: an allowlisted
   * public funder ties nothing together. A wallet with no known source is a cluster of its own.
   */
  private clusterKeys(c: Candidate): (wallet: string) => string {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      let y = x; // path compression
      while (y !== r) { const n = parent.get(y)!; parent.set(y, r); y = n; }
      return r;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra); // the smaller key is the root: the result does not depend on order
    };
    const creator = new Map<string, boolean>();
    const isCreator = (w: string): boolean => {
      let v = creator.get(w);
      if (v === undefined) creator.set(w, (v = this.inCreatorCluster(c, w)));
      return v;
    };
    const wallets = new Set<string>([...c.buyVolumeByWallet.keys(), ...c.flow.map((f) => f.wallet)]);
    for (const w of wallets) {
      if (isCreator(w)) continue;
      for (const src of this.sourcesOf(w)) if (!this.publicFunders.has(src)) union(w, src);
    }
    return (w: string) => (isCreator(w) ? CREATOR_CLUSTER : `cluster:${find(w)}`);
  }

  public computeMetrics(c: Candidate, now: number): WatchMetrics {
    const first = c.firstTradeAt;
    const elapsedMs = first === null ? 0 : Math.max(0, now - first);
    const buyVolume = [...c.buyVolumeByWallet.values()].reduce((a, b) => a + b, 0);
    const clusterOf = this.clusterKeys(c);

    // R13-2: the R8-2 one-buyer rule in velocity and flow too. A wallet in a cluster with no independent wallet in it is UNATTRIBUTED_BUYERS
    // when its funder lookup found no source or did not read its whole history, or when a lookup is wired and it has no answer (asked and
    // failed, or outside the funder sample; a pending one holds the verdict, see evaluate). All of them together are one buyer, so
    // self-funded, long-history or unread sybils cannot carry the distinct-buyer floors. In velocity their sells net against that one key;
    // in flow a seller keeps its own key (the pessimistic side: more selling clusters).
    // A window with no lookup wired (a replay of recordings without funder history, such as the HF corpus) cannot tell an unknown wallet
    // from an independent one; it still counts such a wallet apart, as before, so those replays overstate velocity and flow against live.
    const independentClusters = new Set<string>();
    for (const f of c.flow) if (this.isVerified(f.wallet)) independentClusters.add(clusterOf(f.wallet));
    const hasFact = (w: string): boolean => !!this.funderFor(w) || this.noFunder.has(w);
    const keyOf = (wallet: string, key: string): string =>
      key === CREATOR_CLUSTER || independentClusters.has(key) || (!this.requestFunder && !hasFact(wallet)) ? key : UNATTRIBUTED_BUYERS;

    // P4.1 (R1-55): the creator cluster's trades are not demand. Flow, velocity and net inflow count the organic trades only.
    const buckets: number[] = [];
    const organic: Array<{ at: number; sol: number; key: string }> = [];
    let buyCount = 0, sellCount = 0, creatorClusterBuySol = 0, creatorClusterSellSol = 0;
    const buyClusters = new Set<string>(), sellClusters = new Set<string>();
    for (const f of c.flow) {
      const key = clusterOf(f.wallet);
      if (key === CREATOR_CLUSTER) {
        if (f.buy) creatorClusterBuySol += f.sol; else creatorClusterSellSol -= f.sol;
        continue;
      }
      organic.push({ at: f.at, sol: f.sol, key: keyOf(f.wallet, key) });
      if (f.buy) { buyCount++; buyClusters.add(keyOf(f.wallet, key)); } else { sellCount++; sellClusters.add(key); }
      const idx = Math.max(0, Math.floor((f.at - (first ?? f.at)) / WATCH_BUCKET_MS));
      while (buckets.length <= idx) buckets.push(0);
      buckets[idx] += f.sol;
    }
    const cumulative = buckets.reduce((a, b) => a + b, 0);

    const clusters = new Map<string, number>();
    for (const [wallet, vol] of c.buyVolumeByWallet) {
      const k = clusterOf(wallet);
      clusters.set(k, (clusters.get(k) ?? 0) + vol);
    }
    // P4.1 (R1-60): coverage over the largest buyers by volume, so a launch with hundreds of small buyers can still be measured
    const sample = this.fundersSample(c);
    const known = sample.filter((w) => this.funderKnown(c, w)).length;
    const rawUnique = c.buyVolumeByWallet.size;
    // B3: a seller whose funder lookup is outstanding or failed, and who is not in the sample, counts as one more unknown funder
    const inSample = new Set(sample);
    const unresolvedSellers = [...c.sellersPending, ...c.sellersUnreadable].filter((w) => !inSample.has(w)).length;
    const funderCoverage = sample.length + unresolvedSellers === 0 ? 0 : known / (sample.length + unresolvedSellers);
    const largestShare = buyVolume > 0 ? Math.max(...clusters.values()) / buyVolume : null;

    let velocity: WatchSignals['velocity'] = null;
    if (first !== null && elapsedMs >= this.opts.minMs) {
      // R8-2: each cluster's net inflow in a window counts up to the per-cluster cap; the clusters with a positive net are its distinct buyers
      const windowed = (from: number, to: number) => {
        const net = new Map<string, number>();
        let raw = 0;
        for (const f of organic) {
          if (f.at > from && f.at <= to) { net.set(f.key, (net.get(f.key) ?? 0) + f.sol); raw += f.sol; }
        }
        let capped = 0, distinct = 0;
        for (const v of net.values()) { capped += Math.min(v, VELOCITY_MAX_SOL_PER_WALLET_30S); if (v > 0) distinct++; }
        return { raw, capped, distinct };
      };
      const now30 = windowed(now - 30_000, now);
      const prev30 = windowed(now - 60_000, now - 30_000);
      const solPerMin = now30.capped * 2;
      const rising = now30.capped > prev30.capped;
      velocity = {
        solPerMin, rawSolPerMin: now30.raw * 2, distinctWallets: now30.distinct, rising,
        pass: solPerMin >= HOT_MIN_VELOCITY_SOL_PER_MIN && rising && now30.distinct >= VELOCITY_MIN_DISTINCT_WALLETS,
      };
    }
    // S264 (review 2026-10-24, finding 3): buyers outside the funder sample whose funder was never looked up used to count as one cluster
    // each, so on a launch with more than WATCH_FUNDER_SAMPLE_BUYERS buyers a swarm of small wallets from one funder could pass the
    // unique-buyer gate while coverage (measured over the sample) read 1. They now count as one cluster together; concentration still sees
    // each of them on its own, so a busy launch is not rejected for a cluster it cannot measure.
    // R2-1 / R8-2: likewise every cluster made only of wallets that are not independent (no funder found, or a history not read in full)
    // counts as one together: a set of self-funded or long-history sybils is one buyer, not many.
    const sampled = new Set(sample);
    let unknownOutside = false;
    const counted = new Set<string>(), unverifiedOnly = new Set<string>();
    for (const wallet of c.buyVolumeByWallet.keys()) {
      if (!sampled.has(wallet) && !this.funderKnown(c, wallet)) { unknownOutside = true; continue; }
      const k = clusterOf(wallet);
      if (k === CREATOR_CLUSTER || !this.funderKnown(c, wallet) || this.isVerified(wallet)) counted.add(k); else unverifiedOnly.add(k);
    }
    const lumped = [...unverifiedOnly].some((k) => !counted.has(k));
    const uniqueBuyers = counted.size + (unknownOutside ? 1 : 0) + (lumped ? 1 : 0);
    const signals: WatchSignals = {
      velocity,
      buyers: rawUnique === 0 ? null : { count: uniqueBuyers, funderCoverage, pass: uniqueBuyers >= HOT_MIN_UNIQUE_BUYERS && funderCoverage === 1 },
      concentration: largestShare === null ? null : { share: largestShare, pass: largestShare < HOT_MAX_LARGEST_BUYER_SHARE },
      flow: c.tradeCount === 0 ? null : {
        buyCount, sellCount, buyWallets: buyClusters.size, sellWallets: sellClusters.size,
        pass: buyClusters.size > sellClusters.size && buyClusters.size >= FLOW_MIN_DISTINCT_BUYERS,
      },
    };
    const passingSignals = Object.values(signals).filter((s) => s && s.pass).length;

    return {
      mint: c.mint, creator: c.creator, firstTradeAt: first, elapsedMs, tradeCount: c.tradeCount,
      netInflowPer10s: buckets, cumulativeNetInflowSol: cumulative, creatorClusterBuySol, creatorClusterSellSol,
      buyVolumeSol: buyVolume, sellVolumeSol: c.sellVolumeSol,
      rawUniqueBuyers: rawUnique, uniqueBuyers, funderCoverage,
      buyCount, sellCount, buySellRatio: sellCount > 0 ? buyCount / sellCount : null,
      largestBuyerShare: largestShare, creatorSold: c.creatorSold, signals, passingSignals,
    };
  }

  private release(c: Candidate, state: Exclude<WatchState, 'WATCHING'>, reason: string, now: number, score: number | null = null): WatchResult {
    const result: WatchResult = { state, reason, metrics: this.computeMetrics(c, now), score, releasedAt: now };
    this.active.delete(c.mint);
    this.released.set(c.mint, result);
    if (this.released.size > 200) this.released.delete(this.released.keys().next().value as string);
    this.emit('release', result);
    return result;
  }

  /** What the window has decided about a mint: its verdict if released, WATCHING if still held, null if never watched. */
  public getVerdict(mint: string): WatchVerdict | null {
    const done = this.released.get(mint);
    if (done) {
      return {
        state: done.state, reason: done.reason, releasedAt: done.releasedAt ?? undefined, score: done.score,
        passingSignals: done.metrics.passingSignals, concentrationPass: done.metrics.signals.concentration?.pass ?? null, metrics: done.metrics,
      };
    }
    if (this.active.has(mint)) return { state: 'WATCHING', reason: 'still in the watch window' };
    return null;
  }

  /** The score a HOT release needs: a what-if replay's own value, else the shared threshold in force. */
  private minScore(): number {
    return this.opts.minScore ?? getConfluenceThreshold();
  }

  /** Judge one candidate at `now`; releases it when a verdict is due. */
  public evaluate(mint: string, now = Date.now()): WatchResult | null {
    const done = this.released.get(mint);
    if (done) return done;
    const c = this.active.get(mint);
    if (!c) return null;

    // P4.1 (R1-60): a buyer that has become one of the largest is looked up even if it arrived after the first sample filled
    if (c.buyVolumeByWallet.size > WATCH_FUNDER_SAMPLE_BUYERS) for (const w of this.fundersSample(c)) this.askFunder(c, w);
    const m = this.computeMetrics(c, now);
    const hold = (reason: string): WatchResult => ({ state: 'WATCHING', reason, metrics: m, score: null, releasedAt: null });

    if (c.firstTradeAt === null) {
      if (now - c.registeredAt >= this.opts.maxMs) return this.release(c, 'DEAD', 'NO_TRADES: no trade seen within the window', now);
      return hold('waiting for the first trade');
    }
    // P4.3 (R1-57): a curve past the cap is never bought; checked from the first trade on, the minimum hold does not delay it.
    // Review M2: an unknown progress (null, no token reserve yet) is not a SOL estimate and does not release the launch here.
    const progress = this.curveProgressPct(mint);
    if (progress !== null && isCurveTooFar(progress)) return this.release(c, 'DEAD', curveTooFarReason('CURVE_TOO_FAR', progress), now);
    if (m.elapsedMs < this.opts.minMs) return hold(`holding: ${Math.ceil((this.opts.minMs - m.elapsedMs) / 1000)}s of the minimum left`);

    if (m.cumulativeNetInflowSol < 0) {
      return this.release(c, 'DEAD', `NET_OUTFLOW: cumulative net inflow ${m.cumulativeNetInflowSol.toFixed(4)} SOL is negative`, now);
    }
    // B3: no HOT or READY while a seller's lookup may still answer "creator cluster"; at the window end the launch is judged without it
    if (c.sellersPending.size > 0 && m.elapsedMs < this.opts.maxMs) return hold(`holding: waiting for the funder of ${c.sellersPending.size} seller(s)`);
    // R13-2: likewise a buyer's: its buys may be the creator cluster's, which are not demand
    const buyersPending = [...c.buyersPending].filter((w) => c.buyVolumeByWallet.has(w)).length;
    if (buyersPending > 0 && m.elapsedMs < this.opts.maxMs) return hold(`holding: waiting for the funder of ${buyersPending} buyer(s)`);
    this.sellerFunderStats.pendingAtWindowEnd += c.sellersPending.size; // only non-zero at the window end, where this evaluation releases
    const unread = c.sellersPending.size + c.sellersUnreadable.size;
    const unreadText = unread > 0 ? `; ${unread} seller funder(s) unread, buyers signal not counted` : '';
    const score = this.opts.scoreOf?.(mint) ?? null;
    const min = this.minScore();
    if (m.passingSignals >= HOT_MIN_SIGNALS && score !== null && score >= min) {
      return this.release(c, 'HOT', `${m.passingSignals} strong signals and score ${score} (threshold ${min})${unreadText}`, now, score);
    }
    if (m.elapsedMs >= this.opts.maxMs) {
      return this.release(c, 'READY', `window elapsed with ${m.passingSignals} strong signal(s)${score === null ? ', no score' : `, score ${score}`} (threshold ${min})${unreadText}`, now, score);
    }
    return hold(`watching: ${m.passingSignals}/${HOT_MIN_SIGNALS} strong signals`);
  }

  /** Evaluate every active candidate. */
  public tick(now = Date.now()): WatchResult[] {
    const out: WatchResult[] = [];
    for (const mint of [...this.active.keys()]) {
      const r = this.evaluate(mint, now);
      if (r && r.state !== 'WATCHING') out.push(r);
    }
    return out;
  }

  /** Everything the board needs: live metrics for watched mints and the verdicts already given. */
  /**
   * B3b: how often a seller's funder ended up unread (the lookup failed after its retries or was refused, or was still pending at the
   * window end), out of the seller lookups asked for. A growing share means the funder lookups need more RPC capacity.
   */
  public getSellerFunderStats(): { asked: number; unreadable: number; pendingAtWindowEnd: number } {
    return { ...this.sellerFunderStats };
  }

  public getSnapshot(now = Date.now()): { watching: Array<{ metrics: WatchMetrics; state: 'WATCHING' }>; released: WatchResult[]; capacity: { active: number; max: number; refusedFull: number; lastRefusedMint: string | null } } {
    return {
      capacity: { active: this.active.size, max: this.opts.maxCandidates, refusedFull: this.refusedFull, lastRefusedMint: this.lastRefusedMint },
      watching: [...this.active.values()].map((c) => ({ metrics: this.computeMetrics(c, now), state: 'WATCHING' as const })),
      released: [...this.released.values()].slice(-50),
    };
  }

  /**
   * P4.2 (R1-52): release every active candidate DEAD with `reason`. Used when the feed had a gap: a trade in it (a creator sell) may
   * never arrive, so no candidate that was watched across it can be judged HOT or READY.
   */
  public releaseAllDead(reason: string, now = Date.now()): WatchResult[] {
    return [...this.active.values()].map((c) => this.release(c, 'DEAD', reason, now));
  }

  /** Subscribe to a PumpFeedListener: create events start a watch, trade events feed it, a feed gap releases every candidate DEAD. */
  public attach(listener: EventEmitter): void {
    listener.on('create_event', (e: { mint: string; creator: string; user?: string }) => {
      this.watch(e.mint, e.creator, Date.now(), [e.user]);
    });
    listener.on('trade_event', (t: PumpTradeEvent) => this.onTrade(t));
    listener.on('feed_gap', (g: { reason: string; at: number; detail?: string }) => {
      this.releaseAllDead(`FEED_GAP: the log stream had a gap (${g.reason}); trades in it may be missing`, g.at);
    });
  }

  public start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const watchWindow = new WatchWindow();
