import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, FakeServer } from './helpers/domApp';
import { readPillState } from '../src/utils/pnlPill';

/**
 * R10-5 leftover (round 11): the Holding row now says STALE, but the header PnL pill still showed the open figure from an old mark with
 * no marker. /api/wallet/state carries the open positions with their lastMarkTimestamp; the pill now counts the stale marks and says so.
 */
const now = Date.now();
describe('R10-5: the header pill marks an open figure built on a stale mark', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
  });
  afterEach(async () => { await removeDom(); });

  it('one position marked 6 minutes ago: the open figure is amber and says 1 STALE mark', async () => {
    server.routes['/api/wallet/state'] = () => ({ json: { success: true, data: {
      totalRealizedPnLUsd: 0, totalUnrealizedPnLUsd: 0.4, activePositionsCount: 1,
      activePositions: [{ id: 'a', status: 'OPEN', lastMarkTimestamp: now - 380_000 }],
    } } });
    await renderApp();
    const o = document.querySelector('[data-testid="pill-open"]')!;
    expect(o.className).toMatch(/amber/);
    expect(document.querySelector('[data-testid="pill-mark-stale"]')?.textContent).toMatch(/1 STALE mark/);
  });

  it('fresh marks carry no marker', async () => {
    server.routes['/api/wallet/state'] = () => ({ json: { success: true, data: {
      totalRealizedPnLUsd: 0, totalUnrealizedPnLUsd: 0.4, activePositionsCount: 1, activePositions: [{ id: 'a', status: 'OPEN', lastMarkTimestamp: Date.now() }],
    } } });
    await renderApp();
    expect(document.querySelector('[data-testid="pill-mark-stale"]')).toBeNull();
  });

  it('counts only open rows; a missing mark is stale', () => {
    const p = readPillState({ activePositions: [{ status: 'OPEN' }, { status: 'CLOSED', lastMarkTimestamp: 1 }, { status: 'PARTIALLY_CLOSED', lastMarkTimestamp: now }] }, now);
    expect(p?.staleMarks).toBe(1);
  });
});
