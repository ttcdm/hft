import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { buildSystemChecks, SELLER_FUNDER_UNREAD_MIN_ASKED } from '../server/system/systemChecks';
import { watchWindow } from '../server/signals/watchWindow';
import { FunderLookup, wireFunderLookup } from '../server/signals/funderLookup';
import { replay, wallet } from './fixtures/watch';

/**
 * B3b: System checks show how often a seller's funder ended up unread, so an operator can tell whether the funder lookups need more RPC
 * capacity. The real watch window singleton and FunderLookup; the lookup has no Connection (as during an RPC switch), so every seller
 * lookup fails.
 */

afterEach(() => { vi.restoreAllMocks(); });

const capacity = () => JSON.parse(JSON.stringify(buildSystemChecks())).checks.find((c: any) => c.id === 'capacity');

describe('B3b: the capacity check counts unread seller funders', () => {
  it('no seller lookups: 0 of 0; then enough failed ones: WARN with the counts in value and detail', async () => {
    expect(capacity().value).toMatch(/; seller funders unread 0 of 0$/);
    wireFunderLookup(watchWindow, new FunderLookup(() => null, { retryDelaysMs: [] }));
    const mint = Keypair.generate().publicKey.toBase58();
    const start = Date.now();
    watchWindow.watch(mint, wallet(), start);
    const sellers = Array.from({ length: SELLER_FUNDER_UNREAD_MIN_ASKED }, wallet);
    for (const { trade, at } of replay(mint, start, sellers.map((s, i) => [i * 0.1, s, 'sell', 0.01] as [number, string, 'sell', number]))) watchWindow.onTrade(trade, at);
    await vi.waitFor(() => expect(watchWindow.getSellerFunderStats().unreadable).toBe(SELLER_FUNDER_UNREAD_MIN_ASKED));
    const c = capacity();
    expect(c.status).toBe('WARN');
    expect(c.value).toContain(`seller funders unread ${SELLER_FUNDER_UNREAD_MIN_ASKED} of ${SELLER_FUNDER_UNREAD_MIN_ASKED}`);
    expect(c.detail).toContain(`Seller funder lookups: ${SELLER_FUNDER_UNREAD_MIN_ASKED} asked, ${SELLER_FUNDER_UNREAD_MIN_ASKED} failed or refused, 0 still pending at the window end`);
    watchWindow.setFunderRequester(null);
  });
});
