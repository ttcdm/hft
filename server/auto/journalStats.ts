/**
 * H3: session stats for the auto-snipe panel, computed ONLY from decision-journal rows (G3) and the position table.
 * Nothing is estimated: every figure is a count or a sum of journaled values.
 */
export interface DecisionRow {
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
  /** Sum of journaled SOL deltas (buys incl. fees, exits) over fully closed positions. */
  netPnlSol: number;
  feesPaidSol: number;
  /** null with no closed positions. */
  winRate: number | null;
}

export function computeJournalStats(rows: DecisionRow[], positionStatus: (id: string) => string | undefined): JournalStats {
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
    }
  }
  let open = 0, closed = 0, wins = 0, net = 0;
  for (const id of boughtIds) {
    const status = positionStatus(id);
    if (status === 'CLOSED') {
      closed++;
      const pnl = rows.filter((r) => r.positionId === id && r.solDelta !== null).reduce((a, r) => a + (r.solDelta as number), 0);
      net += pnl;
      if (pnl > 0) wins++;
    } else if (status !== undefined) {
      open++;
    }
  }
  return { seen, rejectedByStage, wouldBuy, bought, open, closed, netPnlSol: net, feesPaidSol: fees, winRate: closed > 0 ? wins / closed : null };
}
