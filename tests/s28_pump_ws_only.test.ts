import { describe, it, expect, vi, afterEach } from 'vitest';
import { PumpFunService, pumpBootMode } from '../server/pumpfunService';
import { pumpFeedListener } from '../server/solana/pumpFeedListener';

describe('S28: pump websocket listener without the HTTP pollers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pumpBootMode: feeds on is FULL; feeds off is OFF unless APEX_PUMP_WS_ONLY=true on localnet', () => {
    // P4.2 (R1-65): with feeds on, FULL (the HTTP pollers) is mainnet-beta only; the default cluster (devnet) gets the log stream alone
    expect(pumpBootMode({})).toBe('WS_ONLY');
    expect(pumpBootMode({ ALLOWED_CLUSTER: 'mainnet-beta' })).toBe('FULL');
    expect(pumpBootMode({ APEX_DISABLE_EXTERNAL_FEEDS: 'true' })).toBe('OFF');
    expect(pumpBootMode({ APEX_DISABLE_EXTERNAL_FEEDS: 'true', APEX_PUMP_WS_ONLY: 'true' })).toBe('OFF'); // devnet/unset: never
    expect(pumpBootMode({ APEX_DISABLE_EXTERNAL_FEEDS: 'true', APEX_PUMP_WS_ONLY: 'true', ALLOWED_CLUSTER: 'devnet' })).toBe('OFF');
    expect(pumpBootMode({ APEX_DISABLE_EXTERNAL_FEEDS: 'true', APEX_PUMP_WS_ONLY: 'true', ALLOWED_CLUSTER: 'localnet' })).toBe('WS_ONLY');
    expect(pumpBootMode({ APEX_PUMP_WS_ONLY: 'true', ALLOWED_CLUSTER: 'localnet' })).toBe('WS_ONLY'); // P4.2: feeds on off mainnet is WS_ONLY too (was FULL)
  });

  it('startBackground({ httpPollers: false }) starts the listener and makes no HTTP request', async () => {
    const start = vi.spyOn(pumpFeedListener, 'start').mockResolvedValue(undefined as any);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.useFakeTimers();
    try {
      const svc = new PumpFunService();
      svc.startBackground({ httpPollers: false });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(start).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('the default still starts the pollers on mainnet-beta', () => {
    vi.spyOn(pumpFeedListener, 'start').mockResolvedValue(undefined as any);
    // Fake timers: initPolling also arms a 5 s interval, which must never fire for real in this process (it would call the
    // un-mocked syncRealWorldData and reach pump.fun / DexScreener, which the network guard rightly refuses).
    vi.useFakeTimers();
    try {
      const svc = new PumpFunService();
      const sync = vi.spyOn(svc, 'syncRealWorldData').mockResolvedValue({});
      svc.startBackground({ env: { ALLOWED_CLUSTER: 'mainnet-beta' } }); // P4.2 (R1-65): the pollers need mainnet-beta now (the test env is devnet)
      expect(sync).toHaveBeenCalledTimes(1);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
});

import fs from 'node:fs';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS } from './helpers/liveServer';

describe('S28: a real server boots with APEX_PUMP_WS_ONLY=true on localnet', () => {
  it('comes up, logs no pump.fun/DexScreener fetch, and still answers the API', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    const d = scratchDir('s28-');
    try {
      const app = await startApp(d, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, APEX_PUMP_WS_ONLY: 'true' });
      try {
        expect((await app.call('GET', '/api/auto/status')).status).toBe(200);
        expect(app.logs()).not.toMatch(/frontend-api|dexscreener/i);
      } finally { await app.stop(); }
    } finally { await rpc.close(); fs.rmSync(d, { recursive: true, force: true }); }
  }, 60_000);
});
