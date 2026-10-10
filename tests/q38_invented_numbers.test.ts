import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { signalFeedBadge } from '../src/utils/signalBadge';

describe('Q38/Q39: no invented numbers, no LIVE badge on synthetic data', () => {
  it('synthetic and demo signals get SYNTHETIC even if flagged live; real ones get LIVE', () => {
    expect(signalFeedBadge({ isLiveFeed: true, provenance: 'SYNTHETIC_TEST' })).toBe('SYNTHETIC');
    expect(signalFeedBadge({ isLiveFeed: true, provenance: 'DEMO_PAPER' })).toBe('SYNTHETIC');
    expect(signalFeedBadge({ isLiveFeed: true, provenance: 'REAL_ONCHAIN' })).toBe('LIVE');
    expect(signalFeedBadge({ isLiveFeed: false, provenance: 'REAL_ONCHAIN' })).toBeNull();
  });
  it('the AI diagnostics 503 carries no canned Sharpe or recommendation', () => {
    const src = fs.readFileSync('server.ts', 'utf8');
    expect(src).not.toMatch(/estimatedSharpe|offlineAnalysis|gamma adjustment/);
  });
  it('the demo signal templates are not flagged as a live feed', async () => {
    const src = fs.readFileSync('server/socialScanner.ts', 'utf8');
    const demo = src.slice(0, src.indexOf('export class SocialAlphaScanner'));
    expect(demo).not.toMatch(/isLiveFeed: true/);
  });
  it('a backtest with zero variance reports 0 for Sharpe/Sortino/Calmar, not 3.2/4.5/10', () => {
    const src = fs.readFileSync('src/utils/backtestEngine.ts', 'utf8');
    expect(src).not.toMatch(/: 3\.2;|: 4\.5;|: 10\.0;/);
  });
  it('the Plug-and-Play card no longer states fixed 0.02/0.06 SOL caps', () => {
    expect(fs.readFileSync('src/components/PlugAndPlayTradingModal.tsx', 'utf8')).not.toMatch(/0\.02 SOL \(~\$2\.90|0\.06 SOL \(~\$8\.70/);
  });
});
