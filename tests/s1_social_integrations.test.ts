import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocialAlphaScanner } from '../server/socialScanner';
import { PumpFunService } from '../server/pumpfunService';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { riskEngine } from '../server/risk/riskEngine';
import { MINT_A, MINT_B, pumpCoin, dexBoosts, dexPairs, jsonResponse } from './fixtures/socialFeeds';

const liveTokenInput = (over: Record<string, any> = {}) => ({
  symbol: 'GOAT', name: 'Goatseus', mint: MINT_A, curveProgress: 40, twitter: 'https://x.com/goatse', ...over,
});

describe('S1: Telegram / social integrations', () => {
  beforeEach(() => {
    memecoinAggregator.setConfluenceGating(false); // C2: gating is on by default; this test is about something else
  });

  afterEach(() => {
    vi.restoreAllMocks();
    riskEngine.setKillSwitch(false);
  });

  describe('SocialAlphaScanner signal buffer', () => {
    it('requires explicit provenance on addSignal', () => {
      const s = new SocialAlphaScanner();
      expect(() => s.addSignal({ contractAddress: MINT_A } as any)).toThrow(/MANDATORY_PROVENANCE_REQUIRED/);
    });

    it('caps the buffer at 50 signals, newest first', () => {
      const s = new SocialAlphaScanner();
      for (let i = 0; i < 60; i++) s.addSignal({ provenance: 'REAL_SOCIAL', contractAddress: `m${i}` } as any);
      expect(s.getSignals()).toHaveLength(50);
      expect(s.getSignals()[0].contractAddress).toBe('m59');
    });

    it('starts empty without DEMO_MODE (no synthetic callers or signals)', () => {
      expect(new SocialAlphaScanner().getSignals()).toEqual([]);
    });

    it('ingestLiveTokenSignal: dedupes by mint case-insensitively, ignores a missing mint', () => {
      const s = new SocialAlphaScanner();
      s.ingestLiveTokenSignal(liveTokenInput());
      s.ingestLiveTokenSignal(liveTokenInput({ mint: MINT_A.toLowerCase() }));
      s.ingestLiveTokenSignal(liveTokenInput({ mint: '' }));
      expect(s.getSignals()).toHaveLength(1);
      expect(s.getSignals()[0].provenance).toBe('REAL_ONCHAIN');
    });

    it('ingestLiveTokenSignal: picks the source from available socials and extracts handles', () => {
      const s = new SocialAlphaScanner();
      s.ingestLiveTokenSignal(liveTokenInput({ mint: MINT_A }));
      s.ingestLiveTokenSignal(liveTokenInput({ mint: MINT_B, twitter: undefined, telegram: 'https://t.me/goatse_sol' }));
      const [tg, x] = s.getSignals();
      expect(x.source).toBe('X_TWITTER');
      expect(x.authorHandle).toBe('@goatse');
      expect(tg.source).toBe('TELEGRAM');
      expect(tg.authorHandle).toBe('goatse_sol');
    });

    it('markSniped only touches an existing signal', () => {
      const s = new SocialAlphaScanner();
      s.ingestLiveTokenSignal(liveTokenInput());
      const id = s.getSignals()[0].id;
      expect(s.markSniped('nope')).toBeUndefined();
      expect(s.markSniped(id)?.status).toBe('SNIPED');
    });
  });

  describe('Telegram command parsing', () => {
    it('answers /help and unknown text without any trade', async () => {
      const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
      const s = new SocialAlphaScanner();
      expect((await s.processTelegramCommand('/help')).reply).toContain('Available Commands');
      expect((await s.processTelegramCommand('hello there')).reply).toContain('acknowledged');
      expect((await s.processTelegramCommand('')).reply).toContain('acknowledged');
      expect(snipe).not.toHaveBeenCalled();
    });

    it('/snipe with no mint, a malformed mint, or a bad amount never reaches the sniper', async () => {
      const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
      const s = new SocialAlphaScanner();
      for (const cmd of ['/snipe', '/snipe   ', '/snipe not-a-mint', `/snipe ${MINT_A}x`, `/snipe ${MINT_A} abc`, `/snipe ${MINT_A} -5`, `/snipe ${MINT_A} 0`, `/buy ${MINT_A} Infinity`]) {
        const r = await s.processTelegramCommand(cmd);
        expect(r.reply, cmd).toContain('SNIPE REJECTED');
        expect(r.actionTaken, cmd).toBeUndefined();
      }
      expect(snipe).not.toHaveBeenCalled();
    });

    it('/snipe with a valid mint goes through executeSnipe (the gated funnel) and reports its rejection', async () => {
      const snipe = vi
        .spyOn(memecoinAggregator, 'executeSnipe')
        .mockResolvedValue({ success: false, message: 'REJECTED: test gate', txHash: '' });
      const r = await new SocialAlphaScanner().processTelegramCommand(`/snipe ${MINT_A} 7.5`);
      expect(snipe).toHaveBeenCalledWith(expect.objectContaining({ contractAddress: MINT_A, amountUsd: 7.5 }));
      expect(r.reply).toContain('REJECTED: test gate');
      expect(r.actionTaken).toBeUndefined();
    });

    it('/signals reports an empty buffer and lists real ones', async () => {
      const s = new SocialAlphaScanner();
      expect((await s.processTelegramCommand('/signals')).reply).toContain('No active alpha signals');
      s.ingestLiveTokenSignal(liveTokenInput());
      expect((await s.processTelegramCommand('/signals')).reply).toContain(MINT_A);
    });
  });

  describe('Telegram / X connectivity tests never send without credentials', () => {
    it('with no token: pings api.telegram.org only, makes no getMe/sendMessage call, reports no bot', async () => {
      const urls: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        urls.push(String(input));
        return jsonResponse({ ok: true });
      });
      const s = new SocialAlphaScanner();
      s.updateTelegramConfig({ botToken: '', chatId: '' });
      const r = await s.testTelegramConnection(undefined, '12345', true);
      expect(r.reachable).toBe(true);
      expect(r.botAuthorized).toBeFalsy();
      expect(urls.some((u) => /sendMessage/.test(u))).toBe(false);
      expect(urls.some((u) => /getMe/.test(u))).toBe(false);
    });

    it('network failure is isolated into reachable:false', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      const r = await new SocialAlphaScanner().testTelegramConnection('123:abc');
      expect(r.reachable).toBe(false);
    });

    it('X test with no bearer token makes no authenticated call', async () => {
      const urls: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        urls.push(String(input));
        return jsonResponse({});
      });
      vi.stubEnv('TWITTER_BEARER_TOKEN', '');
      vi.stubEnv('X_API_BEARER_TOKEN', '');
      await new SocialAlphaScanner().testXTwitterConnection();
      vi.unstubAllEnvs();
      expect(urls.some((u) => /users\/by\/username/.test(u))).toBe(false);
    });
  });

  describe('Pump.fun + DexScreener callout ingestion (recorded fixtures)', () => {
    let svc: PumpFunService;
    beforeEach(async () => {
      // The constructor starts its own background sync; keep it off the network and let it finish first.
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
      svc = new PumpFunService();
      await vi.waitFor(() => expect((svc as any).isPolling).toBe(false));
      vi.restoreAllMocks();
    });

    const mockFeeds = (coins: any, boosts: any = [], pairs: any = { pairs: [] }, pumpStatus = 200) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        const u = String(input);
        if (u.includes('frontend-api-v3.pump.fun')) return jsonResponse(coins, pumpStatus);
        if (u.includes('token-boosts')) return jsonResponse(boosts);
        if (u.includes('latest/dex/tokens')) return jsonResponse(pairs);
        throw new Error(`unexpected fetch ${u}`);
      });
    };

    it('builds callouts from a recorded feed with normalized socials, never auto-sniping', async () => {
      mockFeeds([pumpCoin()], dexBoosts([MINT_A]), dexPairs(MINT_A));
      const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
      await svc.syncRealWorldData({ evaluateTriggers: true });
      const [c] = svc.getHotCallouts();
      expect(c.token.mint).toBe(MINT_A);
      expect(c.token.twitter).toBe('https://x.com/goatse');
      expect(c.token.telegram).toBe('https://t.me/goatse_sol');
      expect(c.caller.userId).toBe('unattributed');
      expect(c.status).toBe('ACTIVE');
      // AUTO_SNIPE_ENABLED is not set, so triggers never fire.
      expect(snipe).not.toHaveBeenCalled();
    });

    it('skips coins with no mint instead of inventing one', async () => {
      mockFeeds([pumpCoin({ mint: undefined }), pumpCoin({ mint: '' }), pumpCoin({ mint: MINT_B }), null]);
      await svc.syncRealWorldData({ evaluateTriggers: false });
      expect(svc.getHotCallouts().map((c) => c.token.mint)).toEqual([MINT_B]);
    });

    it('survives an HTTP error and malformed JSON from the feed', async () => {
      mockFeeds({ error: 'rate limited' }, [], { pairs: [] }, 429);
      await expect(svc.syncRealWorldData({ evaluateTriggers: false })).resolves.toBeUndefined();
      expect(svc.getHotCallouts()).toEqual([]);

      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>blocked</html>', { status: 200 }));
      await expect(svc.syncRealWorldData({ evaluateTriggers: false })).resolves.toBeUndefined();
    });

    it('keeps unknown holder/authority data null (not defaulted to safe) on the callout', async () => {
      mockFeeds([pumpCoin()]);
      await svc.syncRealWorldData({ evaluateTriggers: false });
      const t = svc.getHotCallouts()[0].token;
      expect(t.top10HoldersPct).toBeNull();
      expect(t.devHoldingPct).toBeNull();
      expect(t.isMintRevoked).toBeNull();
      expect(t.isFreezeRevoked).toBeNull();
    });

    it('re-polling the same mint does not duplicate the social signal', async () => {
      const spy = vi.spyOn((await import('../server/socialScanner')).socialScanner, 'ingestLiveTokenSignal');
      mockFeeds([pumpCoin()]);
      await svc.syncRealWorldData({ evaluateTriggers: false });
      await svc.syncRealWorldData({ evaluateTriggers: false });
      expect(spy).toHaveBeenCalledTimes(2);
      const { socialScanner } = await import('../server/socialScanner');
      expect(socialScanner.getSignals().filter((s) => s.contractAddress === MINT_A)).toHaveLength(1);
    });

    it('snipeCallout of an unknown id does nothing', async () => {
      const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
      const r = await svc.snipeCallout('does-not-exist');
      expect(r.success).toBe(false);
      expect(snipe).not.toHaveBeenCalled();
    });
  });

  describe('a social signal can never trade without the execution gates', () => {
    it('every social/callout/telegram entry funnels through executeSnipe -> ExecutionCoordinator.executeTrade', async () => {
      const exec = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({
        success: false, lifecycleState: 'RISK_REJECTED', executionMode: 'PAPER', error: 'gate said no', correlationId: 'c',
      } as any);
      const tg = await new SocialAlphaScanner().processTelegramCommand(`/snipe ${MINT_A} 5`);
      const direct = await memecoinAggregator.executeSnipe({ contractAddress: MINT_A, amountUsd: 5, provenance: 'REAL_SOCIAL' });
      expect(exec).toHaveBeenCalled();
      for (const call of exec.mock.calls) expect(call[0].source).toBe('AUTO_SNIPER');
      expect(tg.reply).toContain('gate said no');
      expect(direct.success).toBe(false);
    });

    it('the real risk engine blocks a social-sourced snipe (kill switch) and opens no position', async () => {
      const before = memecoinAggregator.getPositions().length;
      riskEngine.setKillSwitch(true);
      const r = await memecoinAggregator.executeSnipe({ contractAddress: MINT_A, amountUsd: 5, provenance: 'REAL_SOCIAL' });
      expect(r.success).toBe(false);
      expect(memecoinAggregator.getPositions()).toHaveLength(before);
    });

    it('in LIVE a callout-only token (no readable curve) is not tradable: no fabricated safe pool', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
      const svc = new PumpFunService();
      await vi.waitFor(() => expect((svc as any).isPolling).toBe(false));
      vi.restoreAllMocks();
      vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) =>
        String(input).includes('frontend-api-v3.pump.fun') ? jsonResponse([pumpCoin({ mint: MINT_B })]) : jsonResponse([]));
      await svc.syncRealWorldData({ evaluateTriggers: false });
      const { pumpFunService } = await import('../server/pumpfunService');
      vi.spyOn(pumpFunService, 'getHotCallouts').mockReturnValue(svc.getHotCallouts());
      const exec = vi.spyOn(executionCoordinator, 'executeTrade');
      expect(svc.getHotCallouts()).toHaveLength(1);
      const r = await memecoinAggregator.executeSnipe({ contractAddress: MINT_B, amountUsd: 5 });
      expect(exec).not.toHaveBeenCalled();
      expect(r.success).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('Telegram config never leaks the bot token', () => {
    it('redacts the token, reports only whether one is set, and ignores unknown or mistyped keys', () => {
      const s = new SocialAlphaScanner();
      s.updateTelegramConfig({ botToken: '  123456:SECRET-TOKEN ', chatId: 42 as any, rogue: 'x', snipeThresholdScore: 9999 } as any);
      const red = s.getTelegramConfigRedacted();
      expect(JSON.stringify(red)).not.toContain('SECRET-TOKEN');
      expect(red.botTokenSet).toBe(true);
      expect(s.getTelegramConfig().botToken).toBe('123456:SECRET-TOKEN');
      expect((s.getTelegramConfig() as any).rogue).toBeUndefined();
      expect(s.getTelegramConfig().chatId).not.toBe(42);
      expect(s.getTelegramConfig().snipeThresholdScore).toBe(100);
    });

    it('the config routes answer from the redacted view and the auth gate denies them without a token', async () => {
      const { isPublicApiRoute } = await import('../server/middleware/auth');
      const fs = await import('fs');
      const src = fs.readFileSync('server.ts', 'utf8');
      expect(src).not.toMatch(/config: socialScanner\.getTelegramConfig\(\)/);
      expect(src.match(/getTelegramConfigRedacted\(\)/g)).toHaveLength(2);
      for (const [m, p] of [['GET', '/api/telegram/config'], ['POST', '/api/telegram/config'], ['GET', '/api/connectivity/diagnostics']]) {
        expect(isPublicApiRoute(m, p), `${m} ${p}`).toBe(false);
      }
    });
  });

  describe('diagnostics text matches reality (S1c)', () => {
    it('says plainly that setWebhook, polling and alert forwarding are not implemented', async () => {
      const fs = await import('fs');
      const src = fs.readFileSync('server.ts', 'utf8');
      expect(src).toContain('NOT implemented: setWebhook registration with Telegram, getUpdates polling, and alert forwarding');
      expect(src).not.toContain('broadcasts real messages when a live BotFather token is saved');
    });
  });

  describe('route wiring (static)', () => {
    it('the Telegram webhook, config and test routes require operator auth', async () => {
      const fs = await import('fs');
      const src = fs.readFileSync('server.ts', 'utf8');
      for (const route of ['/api/telegram/webhook', '/api/telegram/config', '/api/telegram/test-connection', '/api/social/test-twitter', '/api/social/signals/snipe']) {
        expect(src, route).toMatch(new RegExp(`app\\.post\\('${route}', requireOperatorAuth`));
      }
    });
  });
});
