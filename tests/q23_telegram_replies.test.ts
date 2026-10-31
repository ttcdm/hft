import fs from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { socialScanner } from '../server/socialScanner';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { workstationDb } from '../server/db/database';
import { executionCoordinator } from '../server/execution/coordinator';
import { riskEngine } from '../server/risk/riskEngine';

afterEach(() => { vi.restoreAllMocks(); riskEngine.setKillSwitch(false); });

describe('Q23: Telegram replies tell the truth', () => {
  // P1.4: /panic_sell sells every ACTIVE row of every mode through the coordinator (emergencyStop), no longer the aggregator's mode-scoped list
  it('/panic_sell reports a failed close as still open, not as liquidated', async () => {
    vi.spyOn(workstationDb, 'loadPositions').mockReturnValue([{ id: 'a', symbol: 'AAA' }, { id: 'b', symbol: 'BBB' }] as any);
    vi.spyOn(executionCoordinator, 'closePosition').mockImplementation((async (id: string) => id === 'a' ? { success: true, pnlSol: 1 } : { success: false, pnlSol: 0, error: 'RPC down' }) as any);
    const r = await socialScanner.processTelegramCommand('/panic_sell');
    expect(r.reply).toMatch(/INCOMPLETE/);
    expect(r.reply).toMatch(/Still open: BBB \(RPC down\)/);
    expect(r.reply).toMatch(/Closed 1: AAA/);
    expect(r.actionTaken).toBe('PANIC_SELL_PARTIAL');
  });
  it('a clean /panic_sell says COMPLETE', async () => {
    // listed until it is closed, gone after (R12-5/R13-14: the auto kill inside the panic now reads the open positions too)
    let closed = false;
    vi.spyOn(workstationDb, 'loadPositions').mockImplementation(() => (closed ? [] : [{ id: 'a', symbol: 'AAA' }]) as any);
    vi.spyOn(executionCoordinator, 'closePosition').mockImplementation(async () => { closed = true; return { success: true, pnlSol: 0 } as any; });
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
