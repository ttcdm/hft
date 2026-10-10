import { describe, it, expect } from 'vitest';
import { AutoSnipeController } from '../server/auto/controller';

describe('S17: kill() and setMode() do not wait forever for a buy in flight', () => {
  it('kill returns after the wait limit when the in-flight buy never settles', async () => {
    const c = new AutoSnipeController() as any;
    c.inflightWaitMs = 30;
    c.inflight = new Promise<void>(() => {}); // never settles
    const t0 = Date.now();
    const r = await c.kill({ reason: 'test' });
    expect(r.mode).toBe('OFF');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('setMode(OFF) also returns, and a buy that settles in time is still awaited', async () => {
    const c = new AutoSnipeController() as any;
    c.inflightWaitMs = 30;
    c.inflight = new Promise<void>(() => {});
    expect((await c.setMode('OFF')).ok).toBe(true);
    let done = false;
    c.inflightWaitMs = 5_000;
    c.inflight = new Promise<void>((r) => setTimeout(() => { done = true; r(); }, 20));
    await c.kill({});
    expect(done).toBe(true);
  });
});
