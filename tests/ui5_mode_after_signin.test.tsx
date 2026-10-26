import { describe, it, expect, vi, afterEach } from 'vitest';
import * as engineClient from '../src/services/engineClient';
import { announceAuthenticated } from '../src/utils/authEvents';
import { subscribeTradingMode } from '../src/utils/tradingMode';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/** From the 2026-10-26 click-through (overnight/reports/click-through-2026-10-26). Fails on c47125e without its fix. */
describe('UI-5: the mode banner reads the server right after sign-in', () => {
  it('a sign-in triggers a poll at once, not at the next 5 s tick', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.useFakeTimers();
    const auth = vi.spyOn(engineClient, 'authFetch').mockResolvedValue(new Response('{}', { status: 401 }));
    const off = subscribeTradingMode(() => {});
    const before = auth.mock.calls.length;
    announceAuthenticated();
    expect(auth.mock.calls.length).toBe(before + 1);
    off();
  });
});
