/**
 * H3: session stats for the auto-snipe panel, computed ONLY from decision-journal rows (G3) and the position table.
 * Nothing is estimated: every figure is a count or a sum of journaled values.
 */
export interface DecisionRow {
  ts?: number;
  autoMode?: string;
  stage: string;
  outcome: string;
  positionId: string | null;
  solDelta: number | null;
  inputs: any;
}

export interface JournalStats {
  seen: number;
  rejectedByStage: Record<string, number>;
  wouldBuy: number;
  bought: number;
  open: number;
  closed: number;
  /**
   * R6-3: sum of the position ledger's realized PnL (realizedPnLSol) over fully closed positions. It used to be the sum of journaled SOL
   * deltas, which a PAPER exit never writes (so every PAPER session showed 0) and an exit booked outside closePosition (startup sell
   * recovery, an adopted sell) never writes either (so that trade counted as a total loss).
   */
  netPnlSol: number;
  feesPaidSol: number;
  /** null with no closed positions. */
  winRate: number | null;
}

/** R6-3: what the panel needs to label the stats: the mode and window they cover, and what they leave out. */
export interface JournalStatsReport extends JournalStats {
  /** The one auto mode whose rows were counted (rows of other modes are left out), or null when auto has not run. */
  mode: 'SHADOW' | 'PAPER' | 'DEVNET_LIVE' | null;
  /** ms. The oldest row counted: the session start, or (no session, or the read hit its row limit) the oldest row read. null with no rows. */
  windowStart: number | null;
  windowEnd: number;
  /** Rows of `mode` counted, out of `rowsRead` read (newest first, at most `rowLimit`). */
  rowsCounted: number;
  rowsRead: number;
  rowLimit: number;
  /** true when the read hit `rowLimit`, so older rows of the window are not counted. */
  truncated: boolean;
  pnlSource: 'position ledger realizedPnLSol';
  /** Plain-text limits the UI shows next to the figures. */
  notes: string[];
}

export interface PositionFacts {
  status: string;
  realizedPnLSol?: number;
}

/**
 * `outcomes` that make a position auto-owned for the stats: BOUGHT, and (R5-12) an auto buy sent unresolved whose position (keyed by its
 * signature) exists, because orphan recovery adopted it later.
 */
export function computeJournalStats(rows: DecisionRow[], position: (id: string) => PositionFacts | undefined, unresolvedOutcome = 'SENT_UNRESOLVED'): JournalStats {
  const rejectedByStage: Record<string, number> = {};
  let seen = 0, wouldBuy = 0, bought = 0, fees = 0;
  const boughtIds = new Set<string>();
  for (const r of rows) {
    if (r.outcome === 'QUEUED') seen++;
    else if (r.outcome === 'REJECTED' || r.outcome === 'DROPPED') rejectedByStage[r.stage] = (rejectedByStage[r.stage] ?? 0) + 1;
    else if (r.outcome === 'WOULD_BUY') wouldBuy++;
    else if (r.outcome === 'BOUGHT') {
      bought++;
      fees += Number(r.inputs?.feesSol ?? 0);
      if (r.positionId) boughtIds.add(r.positionId);
    } else if (r.outcome === unresolvedOutcome && r.positionId && position(r.positionId) !== undefined && !boughtIds.has(r.positionId)) {
      bought++; // the unresolved buy landed (recovery opened its position)
      boughtIds.add(r.positionId);
    }
  }
  let open = 0, closed = 0, wins = 0, net = 0;
  for (const id of boughtIds) {
    const p = position(id);
    if (p?.status === 'CLOSED') {
      closed++;
      const pnl = p.realizedPnLSol ?? 0;
      net += pnl;
      if (pnl > 0) wins++;
    } else if (p !== undefined) {
      open++;
    }
  }
  return { seen, rejectedByStage, wouldBuy, bought, open, closed, netPnlSol: net, feesPaidSol: fees, winRate: closed > 0 ? wins / closed : null };
}

/**
 * 3E (R1-44, R1-124): the trades NEGATIVE_EXPECTANCY and LOSS_STREAK judge. The last `n` closed trades the auto trader owns, across
 * sessions and restarts, that closed after the operator's last acknowledgement (`afterTs`, null when there is none). Net PnL, oldest first.
 * `closed` must be oldest first (loadEvidenceClosedTrades is), so evidence the operator has not looked at carries into a new session.
 */
export function autoEvidencePnl(
  closed: Array<{ id: string; realizedPnLSol?: number; lastUpdatedTimestamp?: number }>,
  owned: Set<string>,
  opts: { afterTs: number | null; n: number }
): number[] {
  return closed
    .filter((p) => owned.has(p.id) && (opts.afterTs === null || (p.lastUpdatedTimestamp ?? 0) > opts.afterTs))
    .slice(-opts.n)
    .map((p) => p.realizedPnLSol ?? 0);
}
