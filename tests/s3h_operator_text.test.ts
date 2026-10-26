import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';
import { connectivityAuditSummary, probeBadge } from '../src/utils/probeBadge';

/** 3H: screens, routes and diagnostics say what the code does (notes/placeholder-inventory.md, the items 3H owns). */

/** Every `app.<method>('/api/...')` route the server registers. server.ts is the only place routes are registered (B1 removed the other file). */
function serverRoutes(): string[] {
  const src = fs.readFileSync('server.ts', 'utf8');
  return [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*'(\/api\/[^']*)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
}

describe('3H B1: the Binance market routes left over from the BTC market maker are gone', () => {
  it('the route walk finds no /api/market/orderbook, /trades (without a mint), /ticker or /depth', () => {
    const routes = serverRoutes();
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((r) => /\/api\/market\/(orderbook|ticker|depth|trades)$/.test(r))).toEqual([]);
    // the curve panel's routes are a different thing and stay
    expect(routes).toContain('GET /api/market/curve/:mint');
    expect(routes).toContain('GET /api/market/trades/:mint');
    expect(fs.existsSync('server/market/marketRoutes.ts')).toBe(false);
  });
});

describe('3H B2: the fake PCAP export route is gone', () => {
  it('no /api/export/packets route, and no screen asks for one', () => {
    expect(serverRoutes().filter((r) => r.includes('/api/export/'))).toEqual([]);
    const ui = fs.readdirSync('src', { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of ui) expect(fs.readFileSync(`src/${f}`, 'utf8'), f).not.toContain('/api/export/packets');
  });
});

describe('3H B3: the exchange-era types are gone from src/types.ts', () => {
  it('none of the BTC market-maker shapes is exported', () => {
    const src = fs.readFileSync('src/types.ts', 'utf8');
    for (const t of ['OrderSide', 'OrderStatus', 'OrderBookEntry', 'OrderBook', 'ExecutedTrade', 'LatencyTestSample', 'PublicMarketTrade', 'ActiveOrder', 'AccountBalance', 'ExchangeGatewayConfig', 'MarketTickerStats']) {
      expect(src, t).not.toMatch(new RegExp(`export (interface|type) ${t}\\b`));
    }
  });
});

describe('3H B9: the engine client has no methods without a caller', () => {
  it('updateSniperConfig, getPumpFunLeaderboard, getPumpFunRules and getPumpFunStatus are gone; the methods the screens call stay', async () => {
    const { engineClient } = await import('../src/services/engineClient');
    for (const m of ['updateSniperConfig', 'getPumpFunLeaderboard', 'getPumpFunRules', 'getPumpFunStatus']) expect(typeof (engineClient as any)[m], m).toBe('undefined');
    for (const m of ['getSniperConfig', 'getPumpFunCallouts', 'updatePumpFunRules', 'refreshPumpFunData']) expect(typeof (engineClient as any)[m], m).toBe('function');
  });
});

/** The four placeholder strings the diagnostics route used to carry whatever the probes found. */
const PLACEHOLDER_STRINGS = ['verified (HTTP 200)', 'Avellaneda', 'BTC-USD', 'only on mainnet-beta'];
const OUTSIDE_PROBES = ['telegram', 'xTwitter', 'pumpFun', 'dexScreener'];

describe('3H P3.7: the connectivity diagnostics are built from the probes that ran', () => {
  let rpc: RpcStub;
  const apps: AppHandle[] = [];
  const dirs: string[] = [];
  const boot = async (env: Record<string, string>) => {
    const dir = scratchDir('s3h-diag-');
    dirs.push(dir);
    const fetchLog = path.join(dir, 'fetch.log');
    fs.writeFileSync(fetchLog, '');
    const app = await startApp(dir, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, JITO_BLOCK_ENGINE_URL: '', APEX_TEST_FETCH_LOG: fetchLog, ...env }, { entry: 'tests/helpers/offlineServerEntry.ts' });
    apps.push(app);
    return { app, hosts: () => fs.readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean) };
  };
  beforeAll(async () => { rpc = await startRpcStub(LOCALNET_STUB_GENESIS); }, 30_000);
  afterAll(async () => {
    for (const a of apps) await a.stop();
    await rpc?.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('with external feeds off, no outside probe runs: each says SKIPPED, nothing leaves the host, and the cluster RPC is still probed', async () => {
    const { app, hosts } = await boot({ APEX_DISABLE_EXTERNAL_FEEDS: 'true' });
    const d = await app.call('GET', '/api/connectivity/diagnostics');
    expect(d.status).toBe(200);
    expect(d.json.externalFeedsDisabled).toBe(true);
    for (const k of OUTSIDE_PROBES) {
      expect(d.json.connections[k].testResult, k).toMatchObject({ skipped: true, reachable: false });
      expect(probeBadge(d.json.connections[k].testResult, 'REACHABLE').text, k).toMatch(/^SKIPPED/);
    }
    expect(hosts()).toEqual([]); // neither the boot nor the audit contacted an outside host
    expect(d.json.connections.solanaRpc.testResult.reachable).toBe(true); // the loopback RPC stub
    expect(Object.keys(d.json.connections)).not.toContain('coinbase');
    const text = JSON.stringify(d.json);
    for (const p of PLACEHOLDER_STRINGS) expect(text, p).not.toContain(p);
    // the toast counts the skipped probes as skipped, not as down
    const toast = connectivityAuditSummary(d.json);
    expect(toast).toMatchObject({ level: 'INFO', title: 'CONNECTIVITY AUDIT: ALL ANSWERED' });
    expect(toast.message).toContain('Skipped (external feeds off)');
  }, 180_000);

  it('with feeds on and every outside fetch failing, the rows say the probes failed and carry none of the placeholder text', async () => {
    const { app, hosts } = await boot({ APEX_DISABLE_EXTERNAL_FEEDS: '' });
    const d = await app.call('GET', '/api/connectivity/diagnostics');
    expect(d.status).toBe(200);
    expect(d.json.externalFeedsDisabled).toBe(false);
    for (const k of OUTSIDE_PROBES) {
      const t = d.json.connections[k].testResult;
      expect(t.skipped, k).toBeUndefined();
      expect(t.reachable, k).toBe(false);
      expect(probeBadge(t, 'REACHABLE').text, k).toMatch(/^UNREACHABLE/);
    }
    // the probes really ran (and were refused at the fetch boundary); no BTC-USD probe is among them (the SOL price refresh may still ask Coinbase for SOL-USD)
    const asked = hosts().map((h) => h.split('/')[0]);
    for (const h of ['api.telegram.org', 'api.twitter.com', 'frontend-api-v3.pump.fun', 'api.dexscreener.com']) expect(asked, h).toContain(h);
    expect(hosts().filter((h) => h.includes('BTC'))).toEqual([]);
    const text = JSON.stringify(d.json);
    for (const p of PLACEHOLDER_STRINGS) expect(text, p).not.toContain(p);
    expect(d.json.simulationScopeMatrix.map((r: any) => r.subsystem)).not.toEqual(expect.arrayContaining(['Coinbase Spot Reference']));
    expect(text).not.toMatch(/Microstructure|Coinbase/);
    // the Jito row comes from the transport: no block engine configured here
    const jito = d.json.simulationScopeMatrix.find((r: any) => r.subsystem.startsWith('Jito'));
    expect(jito.nature).toBe('NOT_CONFIGURED');
    expect(jito.details).toContain('forced to 0');
    const toast = connectivityAuditSummary(d.json);
    expect(toast.level).toBe('WARNING');
    expect(toast.title).toBe('CONNECTIVITY AUDIT: 4 OF 5 UNREACHABLE');
    expect(toast.title).not.toContain('COMPLETE');
  }, 180_000);
});

describe('3H P3.7: the pump.fun feed status comes from real feed activity', () => {
  const createEvent = (mint: string) => ({
    signature: 'sig', slot: 1, mint, bondingCurve: mint, user: mint, creator: mint, name: 'Feed Test', symbol: 'FEED', uri: '',
    virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 0n,
    tokenTotalSupply: 1_000_000_000_000_000n, initialPriceSol: 0.000000028, initialMarketCapSol: 28, receivedAt: Date.now(), parsedAt: Date.now(),
    parseLatencyMs: 0.8, source: 'SOLANA_WS_LOGS' as const,
  });

  it('getStatus() with no sync is NO_DATA (never ONLINE), names no source and has no 1970 sync time', async () => {
    const { PumpFunService } = await import('../server/pumpfunService');
    const st = new PumpFunService().getStatus();
    expect(st.status).toBe('NO_DATA');
    expect(st.status).not.toBe('ONLINE');
    expect(st.liveSource).toBe('none yet');
    expect(st.lastSyncTimeStr).toBeNull();
    expect(st.lastSyncAgeMs).toBeNull();
  });

  it('a log-stream create event makes it ONLINE; a minute with nothing after it makes it STALE', async () => {
    const { PumpFunService, PUMP_FEED_ONLINE_WINDOW_MS } = await import('../server/pumpfunService');
    const svc = new PumpFunService();
    const t0 = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(t0);
    try {
      svc.handleOnChainCreateEvent(createEvent('FeedStatusMint1111111111111111111111111111') as any);
      expect(svc.getStatus()).toMatchObject({ status: 'ONLINE', liveSource: 'Solana WebSocket Logs (Pump.fun V2)', lastSyncAgeMs: 0 });
      clock.mockReturnValue(t0 + PUMP_FEED_ONLINE_WINDOW_MS);
      expect(svc.getStatus().status).toBe('ONLINE');
      clock.mockReturnValue(t0 + PUMP_FEED_ONLINE_WINDOW_MS + 1);
      expect(svc.getStatus().status).toBe('STALE');
    } finally {
      clock.mockRestore();
    }
  });

  it('the callouts screen shows that status, not a fixed "live" claim', async () => {
    const { FeedStatusPill } = await import('../src/components/PumpFunHotCalloutsView');
    expect(renderToStaticMarkup(React.createElement(FeedStatusPill, { status: 'NO_DATA' }))).toContain('NO FEED DATA YET');
    expect(renderToStaticMarkup(React.createElement(FeedStatusPill, { status: 'STALE' }))).toContain('FEED STALE');
    expect(renderToStaticMarkup(React.createElement(FeedStatusPill, { status: 'ONLINE' }))).toContain('FEED ONLINE');
    expect(renderToStaticMarkup(React.createElement(FeedStatusPill, { status: null }))).toContain('UNKNOWN');
  });
});

describe('3H: callout copy says what the feed gave', () => {
  const MINT_PLAIN = 'PlainCoin111111111111111111111111111111pump';
  const MINT_BOOSTED = 'BoostCoin111111111111111111111111111111pump';
  /** The pump.fun and DexScreener HTTP answers, at the fetch boundary. Two coins: one with no description or image, one also boosted. */
  const stubFeeds = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('frontend-api-v3.pump.fun')) {
      return json([
        { mint: MINT_PLAIN, symbol: 'PLN', name: 'Plain', usd_market_cap: 9000, last_trade_timestamp: Date.now() - 600_000, complete: false },
        { mint: MINT_BOOSTED, symbol: 'BST', name: 'Boosted', usd_market_cap: 20000, last_trade_timestamp: Date.now() - 600_000, complete: false, image_uri: 'https://img.example/b.png', description: 'its own words' },
      ]);
    }
    if (url.includes('token-boosts')) return json([{ chainId: 'solana', tokenAddress: MINT_BOOSTED }]);
    if (url.includes('latest/dex/tokens')) return json({ pairs: [] });
    throw new Error(`unexpected fetch ${url}`);
  });

  it('a coin with no description gets no "Verified" text and an empty image; a boosted one is not said to be called by anyone or elevated when it is not', async () => {
    const { PumpFunService } = await import('../server/pumpfunService');
    const svc = new PumpFunService();
    const fetchSpy = stubFeeds();
    try {
      await svc.syncRealWorldData({ evaluateTriggers: false, env: { ...process.env, ALLOWED_CLUSTER: 'mainnet-beta' } });
    } finally {
      fetchSpy.mockRestore();
    }
    const byMint = new Map(svc.getHotCallouts().map((c) => [c.token.mint, c]));
    const plain = byMint.get(MINT_PLAIN)!;
    expect(plain.token.description).toBe('');
    expect(plain.token.imageUri).toBe('');
    expect(JSON.stringify(plain)).not.toMatch(/Verified|unsplash|Alpha Meme Token/);
    const boosted = byMint.get(MINT_BOOSTED)!;
    expect(boosted.confluenceCount).toBeGreaterThanOrEqual(2);
    expect(boosted.token.description).toBe('its own words');
    expect(boosted.token.imageUri).toBe('https://img.example/b.png');
    expect(boosted.hftAction).not.toBe('INSTANT_SNIPE'); // 10 minutes since the last trade
    expect(boosted.calloutNote).not.toMatch(/MULTI-CALLER CONFLUENCE|Called by|Elevated to INSTANT_SNIPE/);
    expect(boosted.calloutNote).toContain('DexScreener paid-boost list');
    expect(boosted.calloutNote).toContain(`Marked ${boosted.hftAction}`);
    expect(svc.getStatus().status).toBe('ONLINE'); // the poll brought coins
  });

  it('the note says INSTANT_SNIPE only when the callout is INSTANT_SNIPE', async () => {
    const { confluenceCalloutNote } = await import('../server/pumpfunService');
    expect(confluenceCalloutNote({ hasOrderFlowSurge: true, curveProgress: 40, volume5mUsd: 1200, hftAction: 'INSTANT_SNIPE' })).toContain('Marked INSTANT_SNIPE.');
    const late = confluenceCalloutNote({ hasOrderFlowSurge: false, curveProgress: 40, volume5mUsd: null, hftAction: 'DUMP_RISK' });
    expect(late).toContain('Marked DUMP_RISK');
    expect(late).toContain('5m Vol: n/a');
  });

  it('the board shows an empty tile, not a stock photo, for a coin with no image', async () => {
    const { TokenImage } = await import('../src/components/PumpFunHotCalloutsView');
    const html = renderToStaticMarkup(React.createElement(TokenImage, { uri: '', symbol: 'PLN' }));
    expect(html).toContain('token-image-missing');
    expect(html).not.toContain('unsplash');
    expect(fs.readFileSync('src/components/PumpFunHotCalloutsView.tsx', 'utf8')).not.toContain('photo-1622979135225');
  });
});
