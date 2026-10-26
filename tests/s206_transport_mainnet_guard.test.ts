import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Connection, VersionedTransaction } from '@solana/web3.js';
import { SolanaRpcTransport, JitoTransport } from '../server/solana/transports';

/**
 * S206: the two network transports are the lowest point a signed transaction can leave the process from. Under ALLOWED_CLUSTER=mainnet-beta
 * both refuse before they serialize, call the connection or fetch, so a caller that bypassed the coordinator still sends nothing on mainnet.
 */
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const fakeTx = { serialize: () => new Uint8Array([1]), signatures: [new Uint8Array(64)], message: {} } as unknown as VersionedTransaction;
const fakeConn = () => ({ sendRawTransaction: vi.fn(), getGenesisHash: vi.fn().mockResolvedValue('whatever'), rpcEndpoint: 'http://127.0.0.1:9' }) as unknown as Connection;

describe('S206 transports refuse a mainnet setting', () => {
  it('both submit methods throw CLUSTER_GUARD and touch neither the connection nor fetch', async () => {
    vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
    const conn = fakeConn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network used'));
    await expect(new SolanaRpcTransport(conn).submit(fakeTx)).rejects.toThrow(/CLUSTER_GUARD.*mainnet-beta/);
    await expect(new JitoTransport(conn, 'http://127.0.0.1:9').submit(fakeTx)).rejects.toThrow(/CLUSTER_GUARD.*mainnet-beta/);
    expect((conn as any).sendRawTransaction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('on the default cluster the RPC transport still sends (so the guard is the setting, not the transport)', async () => {
    const conn = fakeConn();
    (conn as any).sendRawTransaction.mockResolvedValue('sig');
    (conn as any).getSignatureStatuses = vi.fn().mockResolvedValue({ value: [] });
    const res = await new SolanaRpcTransport(conn).submit(fakeTx);
    expect((conn as any).sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(res.signature).toBe('sig');
  });
});
