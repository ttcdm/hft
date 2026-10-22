import { describe, it, expect, vi } from 'vitest';
import { readChainErr } from '../scripts/devnet_e2e_steps';

const ERR = { InstructionError: [2, { Custom: 6002 }] };
const nosleep = { sleep: async () => undefined };
const rateLimited = () => Object.assign(new Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":-32007,"message":"15/second request limit reached"}}'), {});

describe("S248 (d'): the on-chain error is read through a rate limit and an empty getTransaction", () => {
  it('a 429 on getTransaction is retried, and the 6002 error is returned (not undefined)', async () => {
    const getTransaction = vi.fn().mockRejectedValueOnce(rateLimited()).mockRejectedValueOnce(rateLimited()).mockResolvedValue({ meta: { err: ERR } });
    const conn = { getTransaction, getSignatureStatuses: vi.fn() };
    expect(await readChainErr(conn, 'sig', nosleep)).toEqual(ERR);
    expect(getTransaction).toHaveBeenCalledTimes(3);
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it('getTransaction empty every time: falls back to getSignatureStatuses with history search', async () => {
    const getSignatureStatuses = vi.fn().mockResolvedValue({ value: [{ confirmationStatus: 'confirmed', err: ERR }] });
    const conn = { getTransaction: vi.fn().mockResolvedValue(null), getSignatureStatuses };
    expect(await readChainErr(conn, 'sig', nosleep)).toEqual(ERR);
    expect(conn.getTransaction).toHaveBeenCalledTimes(5);
    expect(getSignatureStatuses).toHaveBeenCalledWith(['sig'], { searchTransactionHistory: true });
  });

  it('a successful transaction is null; no answer from either read is undefined', async () => {
    expect(await readChainErr({ getTransaction: vi.fn().mockResolvedValue({ meta: { err: null } }), getSignatureStatuses: vi.fn() }, 's', nosleep)).toBeNull();
    const none = { getTransaction: vi.fn().mockRejectedValue(rateLimited()), getSignatureStatuses: vi.fn().mockRejectedValue(rateLimited()) };
    expect(await readChainErr(none, 's', nosleep)).toBeUndefined();
    const unknown = { getTransaction: vi.fn().mockResolvedValue(null), getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }) };
    expect(await readChainErr(unknown, 's', nosleep)).toBeUndefined();
  });

  it('backs off with doubling delays', async () => {
    const delays: number[] = [];
    const conn = { getTransaction: vi.fn().mockResolvedValue(null), getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }) };
    await readChainErr(conn, 's', { sleep: async (ms) => { delays.push(ms); } });
    expect(delays).toEqual([500, 1000, 2000, 4000]);
  });
});
