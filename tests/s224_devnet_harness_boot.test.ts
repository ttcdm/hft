import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { awaitSolPrice } from '../scripts/devnet_funding';
import { SolPriceService } from '../server/market/solPriceService';

const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('S224: the devnet harness starts what server.ts starts for a LIVE buy', () => {
  it('awaitSolPrice reads a real price from the service and never invents one', async () => {
    const svc = new SolPriceService();
    let calls = 0;
    (svc as any).refresh = async () => { calls++; if (calls === 2) svc.setPrice(150, 'TEST'); return svc.getPrice(); };
    expect(await awaitSolPrice(svc, 4, 1)).toEqual({ ok: true, usd: 150 });
    expect(calls).toBe(2);

    const dead = new SolPriceService();
    (dead as any).refresh = async () => dead.getPrice();
    expect(await awaitSolPrice(dead, 3, 1)).toEqual({ ok: false, usd: null });
    expect(dead.getPrice().usd).toBeNull();
  });

  it('every boot-time service a LIVE buy needs is started by the harness, because it does not run server.ts', () => {
    const harness = read('scripts/devnet_e2e.ts');
    const coordinator = read('server/execution/coordinator.ts');
    // 1. A LIVE buy requires a fresh SOL/USD price. server.ts starts the service; so must the harness, and it must wait for the first reading.
    expect(coordinator).toMatch(/solPriceService\.requireFreshPrice\(\)/);
    expect(read('server.ts')).toMatch(/solPriceService\.startForBoot\(/);
    expect(harness).toMatch(/solPriceService\.startAutoRefresh\(\)/);
    expect(harness).toMatch(/awaitSolPrice\(solPriceService\)/);
    // 2. The RPC heartbeat, startup reconciliation, exit monitor and mark feed start in the coordinator constructor, so the harness gets them by
    //    constructing it. If they move out of the constructor, the harness must start them: this fails so that it is noticed.
    const ctor = coordinator.slice(coordinator.indexOf('this.initializeConnection();'), coordinator.indexOf('this.initializeConnection();') + 200);
    expect(ctor).toMatch(/this\.startAutoPositionMonitor\(\)/);
    expect(ctor).toMatch(/this\.startMarketFeedHeartbeat\(\)/);
    expect(harness).toMatch(/new ExecutionCoordinator\(true\)/);
    // 3. No other module the harness uses is allowed to call requireFreshPrice without the harness starting the service.
    const callers = ['server/execution', 'server/risk', 'server/capital', 'server/exits'].flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.ts')).map((f) => `${d}/${f}`))
      .filter((f) => /requireFreshPrice\(\)/.test(read(f)));
    expect(callers).toEqual(['server/execution/coordinator.ts']);
  });

  it('the harness keeps the devnet liquidity minimum off the mint list and sets no hardcoded price', () => {
    const harness = read('scripts/devnet_e2e.ts');
    expect(harness).toMatch(/process\.env\.MIN_LIQUIDITY_USD = '0'/);
    expect(harness).not.toMatch(/setPrice\(/);
    expect(harness).not.toMatch(/LOCALNET_SOL_PRICE_USD/);
  });
});
