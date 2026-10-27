import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyBlockhashIndependently, SELL_BLOCKHASH_RECHECK_DELAYS_MS } from '../server/solana/clusterGuard';

/**
 * R3-6 (with round 1 #9): with APEX_VERIFY_BLOCKHASH=true a SELL was refused as "definite" after two checks 500 ms apart, so a public
 * reference node a few slots behind blocked every stop-loss, though docs/ENV.md said it could not. The real clusterGuard;
 * the reference RPC is the injected `isValid`.
 */
const env = { APEX_VERIFY_BLOCKHASH: 'true', ALLOWED_CLUSTER: 'devnet' } as NodeJS.ProcessEnv;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('R3-6: a SELL polls longer before a definite "no"', () => {
  it('a reference node that catches up on the 4th check lets the SELL through; a BUY is still refused after its one retry', async () => {
    const lag = () => vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    expect(await verifyBlockhashIndependently('bh', env, { isValid: lag(), sleep }, 'SELL')).toEqual({ ok: true });
    expect(await verifyBlockhashIndependently('bh', env, { isValid: lag(), sleep: async () => undefined }, 'BUY')).toMatchObject({ ok: false, definite: true });
  });

  it('a SELL is definite only after every bounded re-check said no', async () => {
    const no = vi.fn(async () => false);
    const slept: number[] = [];
    const v = await verifyBlockhashIndependently('bh', env, { isValid: no, sleep: async (ms) => { slept.push(ms); } }, 'SELL');
    expect(v).toMatchObject({ ok: false, definite: true });
    expect(no).toHaveBeenCalledTimes(SELL_BLOCKHASH_RECHECK_DELAYS_MS.length + 1);
    expect(slept).toEqual([...SELL_BLOCKHASH_RECHECK_DELAYS_MS]);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000); // bounded
  });
});
