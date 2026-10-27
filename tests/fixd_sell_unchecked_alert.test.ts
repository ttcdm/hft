import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * Round 1 #9: with APEX_VERIFY_BLOCKHASH=true a SELL whose blockhash could not be checked (the reference RPC unreachable) went out with
 * only a log line, so the operator never learned the guard was not working. The real coordinator; the reference RPC is a rejected
 * Connection call, no network.
 */
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('R1 #9: a SELL that passes unchecked raises an operator alert', () => {
  it('the reference RPC cannot be asked: the sell is not blocked, and SELL_BLOCKHASH_UNCHECKED is raised', async () => {
    vi.stubEnv('APEX_VERIFY_BLOCKHASH', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    const rpc = new MockSolanaRpc();
    const c = new ExecutionCoordinator(rpc.createConnection());
    const { Connection } = await import('@solana/web3.js');
    vi.spyOn(Connection.prototype, 'isBlockhashValid').mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      const problem = await (c as any).blockhashProblem({ message: { recentBlockhash: 'AnyBlockhash' } }, 'SELL');
      expect(problem).toBeNull();
      expect(c.getOperatorAlerts().some((a) => a.code === 'SELL_BLOCKHASH_UNCHECKED' && !a.cleared)).toBe(true);
    } finally {
      c.cleanup();
      rpc.clear();
    }
  });
});
