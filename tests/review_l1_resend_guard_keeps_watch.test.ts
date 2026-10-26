import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SolanaRpcTransport, confirmPacing } from '../server/solana/transports';

/**
 * Review 2026-10-24 (L1, on S252): the resend inside `SolanaRpcTransport.confirm` goes through `submit`, whose read-only and cluster guards
 * throw before its try. Read-only turned on mid-watch used to throw out of confirm, ending the watch with the row left PENDING. Now the
 * guard stops the resends and the watch goes on. Real SolanaRpcTransport and read-only guard; the Connection is scripted and the confirm
 * clock is virtual, as in s252_rpc_rebroadcast.test.ts.
 */
let clock = 0;
beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(confirmPacing, 'now').mockImplementation(() => clock);
  vi.spyOn(confirmPacing, 'sleep').mockImplementation(async (ms: number) => { clock += ms; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const TX = { serialize: () => Uint8Array.from([1, 2, 3, 4]), signatures: [] } as any;
const confirmed = { slot: 77, confirmations: 1, err: null, confirmationStatus: 'confirmed' };

/** A scripted Connection: `statuses` answers each status poll in turn; the last entry repeats. */
function conn(statuses: Array<unknown>, height: () => number = () => 100) {
  let i = 0;
  return {
    getSignatureStatuses: vi.fn(async (_s?: string[], _o?: any) => ({ context: { slot: 1 }, value: [statuses[Math.min(i++, statuses.length - 1)]] })),
    sendRawTransaction: vi.fn(async () => 'sig'),
    getBlockHeight: vi.fn(async () => height()),
  };
}

describe('L1: a guard that refuses a resend mid-watch stops the resends, not the watch', () => {
  it('read-only turned on after the first resend: no more sends, no throw, and the later confirmation is still seen', async () => {
    const c = conn([null, null, null, null, null, null, null, null, null, null, confirmed]);
    c.sendRawTransaction.mockImplementation(async () => { vi.stubEnv('APEX_READ_ONLY', 'true'); return 'sig'; });
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { rebroadcast: TX, lastValidBlockHeight: 500, resendEveryMs: 400 });
    expect(r).toMatchObject({ confirmed: true, lifecycleState: 'TX_CONFIRMED', slot: 77 });
    expect(c.sendRawTransaction).toHaveBeenCalledTimes(1); // the first resend went out; the guard refused the next and resends stopped
  });

  it('read-only from the start of the watch: never resent, and an unseen transaction still ends EXPIRED_BLOCKHASH, not a throw', async () => {
    vi.stubEnv('APEX_READ_ONLY', 'true');
    const c = conn([null], () => (clock - 1_000_000 < 20_000 ? 500 : 501));
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { rebroadcast: TX, lastValidBlockHeight: 500, resendEveryMs: 400 });
    expect(r.lifecycleState).toBe('EXPIRED_BLOCKHASH');
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });
});
