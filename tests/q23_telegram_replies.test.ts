import fs from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { socialScanner } from '../server/socialScanner';
import { memecoinAggregator } from '../server/memecoinAggregator';

afterEach(() => vi.restoreAllMocks());

describe('Q23: Telegram replies tell the truth', () => {
  it('/panic_sell reports a failed close as still open, not as liquidated', async () => {
    vi.spyOn(memecoinAggregator, 'getPositions').mockReturnValue([{ id: 'a', tokenTicker: 'AAA' }, { id: 'b', tokenTicker: 'BBB' }] as any);
    vi.spyOn(memecoinAggregator, 'closePosition').mockImplementation((async (id: string) => id === 'a' ? { success: true, realizedPnl: 1 } : { success: false, message: 'RPC down' }) as any);
    const r = await socialScanner.processTelegramCommand('/panic_sell');
    expect(r.reply).toMatch(/INCOMPLETE/);
    expect(r.reply).toMatch(/Still open: BBB \(RPC down\)/);
    expect(r.reply).toMatch(/Closed 1: AAA/);
    expect(r.actionTaken).toBe('PANIC_SELL_PARTIAL');
  });
  it('a clean /panic_sell says COMPLETE', async () => {
    vi.spyOn(memecoinAggregator, 'getPositions').mockReturnValue([{ id: 'a', tokenTicker: 'AAA' }] as any);
    vi.spyOn(memecoinAggregator, 'closePosition').mockResolvedValue({ success: true, realizedPnl: 0 } as any);
    const r = await socialScanner.processTelegramCommand('/panic_sell');
    expect(r.reply).toMatch(/COMPLETE/);
    expect(r.actionTaken).toBe('PANIC_SELL_EXECUTED');
  });
  it('a filled /snipe does not claim a Jito bundle or a confirmed block slot', async () => {
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: true, txHash: '', position: { tokenTicker: 'ZZZ', entryPriceUsd: 0.1 } } as any);
    const r = await socialScanner.processTelegramCommand('/snipe 11111111111111111111111111111111 5');
    expect(r.reply).toMatch(/none \(paper fill\)/);
    expect(r.reply).not.toMatch(/Jito|Block Slot|CONFIRMED/);
  });
  it('the status and help text carry no invented latency or tip target', async () => {
    const st = (await socialScanner.processTelegramCommand('/status')).reply;
    expect(st).not.toMatch(/28ms|Jito|apex_alpha_vip_snipers/);
  });
  it('the webhook route puts /snipe and /buy behind the live confirmation', () => {
    const src = fs.readFileSync('server.ts', 'utf8');
    const route = src.slice(src.indexOf("app.post('/api/telegram/webhook'"), src.indexOf("app.post('/api/telegram/test-connection'"));
    expect(route).toMatch(/liveConfirmationRefusal/);
  });
});
