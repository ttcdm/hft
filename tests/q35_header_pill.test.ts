import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import { readPillState, signedUsd, pillTone } from '../src/utils/pnlPill';
import { walletTrader } from '../server/walletTrader';
import { workstationDb } from '../server/db/database';
import { executionCoordinator } from '../server/execution/coordinator';
import { solPriceService } from '../server/market/solPriceService';

/** Q35: the pill read totalPnLUsd and activePositionsCount, which /api/wallet/state never sent, so it showed +$0.00 whatever happened. */
describe('Q35: header profit pill', () => {
  afterEach(() => vi.restoreAllMocks());

  it('getState sends the fields the pill reads: today realized, open marked P&L, open count', () => {
    vi.spyOn(solPriceService, 'lastKnownPrice').mockReturnValue(150);
    vi.spyOn(executionCoordinator, 'getPositions').mockImplementation(((_m: any, status: string) => status === 'ACTIVE'
      ? [{ costBasisLamports: 5_000_000, currentValueSol: 0.0042, unrealizedPnLSol: -0.0008, jitoTipLamports: 0 }, { costBasisLamports: 5_000_000, currentValueSol: 0.0061, unrealizedPnLSol: 0.0011, jitoTipLamports: 0 }]
      : []) as any);
    vi.spyOn(workstationDb, 'getDailyRealizedPnLSol').mockReturnValue(-0.002);
    const s = walletTrader.getState() as any;
    expect(s.activePositionsCount).toBe(2);
    expect(s.totalUnrealizedPnLSol).toBeCloseTo(0.0003, 9);
    expect(s.totalUnrealizedPnLUsd).toBeCloseTo(0.05, 2);
    expect(s.totalRealizedPnLSol).toBeCloseTo(-0.002, 9);
    expect(s.totalRealizedPnLUsd).toBeCloseTo(-0.3, 6);
  });

  it('with no SOL price the dollar fields are null, and the pill shows dashes, not +$0.00', () => {
    vi.spyOn(solPriceService, 'lastKnownPrice').mockReturnValue(null);
    const s = walletTrader.getState() as any;
    expect(s.totalUnrealizedPnLUsd).toBeNull();
    expect(s.totalRealizedPnLUsd).toBeNull();
    const pill = readPillState(s)!;
    expect(signedUsd(pill.realizedUsd)).toBe('—');
    expect(pillTone(pill)).toBe('unknown');
  });

  it('signed amounts and tones', () => {
    expect(signedUsd(1.239)).toBe('+$1.24');
    expect(signedUsd(-0.3)).toBe('-$0.30');
    expect(signedUsd(0)).toBe('+$0.00');
    expect(signedUsd(null)).toBe('—');
    expect(pillTone({ realizedUsd: -0.3, unrealizedUsd: 0.045, openCount: 2 })).toBe('down');
    expect(pillTone({ realizedUsd: 1, unrealizedUsd: null, openCount: 0 })).toBe('up');
    expect(pillTone({ realizedUsd: 0, unrealizedUsd: 0, openCount: 0 })).toBe('flat');
    expect(readPillState(null)).toBeNull();
    expect(readPillState({ totalPnLUsd: 5 })).toEqual({ realizedUsd: null, unrealizedUsd: null, openCount: 0 }); // the old, nonexistent field is not read
  });

  it('the header no longer reads the nonexistent fields or hardcodes a plus sign', () => {
    const src = fs.readFileSync('src/components/Header.tsx', 'utf8');
    expect(src).not.toContain('totalPnLUsd');
    expect(src).not.toContain('totalPnLPct');
    expect(src).not.toContain('+${profitSummary');
  });
});
