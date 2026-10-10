import fs from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { socialScanner, isTelegramTradeCommand } from '../server/socialScanner';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { liveConfirmationRefusal } from '../server/execution/liveConfirmation';

afterEach(() => vi.restoreAllMocks());
const MINT = '11111111111111111111111111111111';

/** S1: the LIVE confirmation had covered 3 of 7 buy entry points. (The HTTP behaviour is in behaviour_http.test.ts.) */
describe('S1: every buy entry point is behind the live confirmation', () => {
  it('the guard accepts only the boolean true, and only matters while LIVE is armed', () => {
    expect(liveConfirmationRefusal(false, 'devnet', {})).toBeNull();
    expect(liveConfirmationRefusal(true, 'devnet', { confirmLive: true })).toBeNull();
    for (const v of [undefined, false, 'true', 1, null]) expect(liveConfirmationRefusal(true, 'devnet', { confirmLive: v })).toMatch(/LIVE_CONFIRMATION_REQUIRED/);
    expect(liveConfirmationRefusal(true, 'devnet', undefined)).toMatch(/LIVE_CONFIRMATION_REQUIRED/);
  });

  it('the telegram guard and the parser agree: any "/snipe..." or "/buy..." prefix is guarded, only the exact commands trade', async () => {
    for (const t of ['/snipe x', '/buy x', '/snipe_x x', '/buyer x', '  /snipe x', '/snipe@MyBot x']) expect(isTelegramTradeCommand(t), t).toBe(true);
    for (const t of ['/status', '/positions', '/panic_sell', 'snipe x', '/signals']) expect(isTelegramTradeCommand(t), t).toBe(false);
    const spy = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: true, txHash: 't', position: { tokenTicker: 'Z', entryPriceUsd: 1 } } as any);
    for (const t of ['/snipe_x ' + MINT, '/buyer ' + MINT, '/snipers ' + MINT]) {
      const r = await socialScanner.processTelegramCommand(t);
      expect(r.reply, t).toMatch(/Unknown command/);
    }
    expect(spy).not.toHaveBeenCalled();
    await socialScanner.processTelegramCommand('/snipe ' + MINT + ' 5');
    await socialScanner.processTelegramCommand('/buy ' + MINT + ' 5');
    await socialScanner.processTelegramCommand('/snipe@MyBot ' + MINT + ' 5');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('the websocket snipe actions and the three HTTP routes call the same gate (source order: gate before the trade)', () => {
    const src = fs.readFileSync('server.ts', 'utf8');
    for (const route of ["'/api/memecoins/trade'", "'/api/wallet/snipe'", "'/api/execution/trade'"]) {
      const line = src.split('\n').find((l) => l.includes(`app.post(${route}`))!;
      expect(line, route).toMatch(/requireOperatorAuth, requireLiveConfirmation,/);
    }
    for (const action of ['SNIPE_PUMP_CALLOUT', 'SNIPE_MEMECOIN']) {
      const at = src.indexOf(`parsed.action === '${action}'`);
      const block = src.slice(at, src.indexOf('parsed.action ===', at + 10));
      expect(block, action).toMatch(/liveGate\(parsed\)/);
      expect(block.indexOf('liveGate(parsed)'), action).toBeLessThan(block.search(/snipeCallout\(|executeSnipe\(/));
    }
  });

  it('the UI asks before, and sends confirmLive from, the two buttons that had no dialog; a 409 shows its real reason', () => {
    const pp = fs.readFileSync('src/components/PlugAndPlayTradingModal.tsx', 'utf8');
    expect(pp).toMatch(/liveClickWarning\(tradingMode/);
    expect(pp).toMatch(/confirmLive: true/);
    const ms = fs.readFileSync('src/components/MemecoinSocialSniperModal.tsx', 'utf8');
    expect(ms).toMatch(/res\?\.tradeResult\?\.message \|\| res\?\.error/);
    expect(ms.slice(ms.indexOf('const handleManualSnipe'))).toMatch(/liveClickWarning/);
    expect(fs.readFileSync('src/components/PumpFunHotCalloutsView.tsx', 'utf8')).toMatch(/res\?\.result\?\.message \|\| res\?\.error/);
  });
});
