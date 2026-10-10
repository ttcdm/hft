import { solPriceService } from '../server/market/solPriceService';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { CLUSTER_GENESIS_HASH } from '../server/solana/clusterGuard';
import { walletTrader } from '../server/walletTrader';
import { executionCoordinator } from '../server/execution/coordinator';
import { WalletConfigSchema } from '../server/middleware/enterprise';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function conn(genesis: string) {
  const c = new Connection('http://127.0.0.1:1', 'confirmed');
  vi.spyOn(c, 'getGenesisHash').mockResolvedValue(genesis);
  vi.spyOn(c, 'getSlot').mockResolvedValue(1);
  return c;
}

describe('K6: mainnet-guard gaps', () => {
  describe('setRpcEndpoint', () => {
    it('rejects a mainnet-looking URL without swapping the connection', async () => {
      const c = new ExecutionCoordinator(conn(CLUSTER_GENESIS_HASH.devnet));
      try {
        const before = (c as any).rpcEndpoint;
        const res = await c.setRpcEndpoint('https://api.mainnet-beta.solana.com');
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/CLUSTER_GUARD/);
        expect((c as any).rpcEndpoint).toBe(before);
      } finally {
        c.cleanup();
      }
    });

    it('rejects an endpoint whose genesis hash is mainnet even with an innocent URL', async () => {
      const c = new ExecutionCoordinator(conn(CLUSTER_GENESIS_HASH.devnet));
      const prev = (c as any).connection;
      vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(CLUSTER_GENESIS_HASH['mainnet-beta']);
      vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
      try {
        const res = await c.setRpcEndpoint('https://rpc.example.test/key');
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/genesis hash/);
        expect((c as any).connection).toBe(prev);
      } finally {
        c.cleanup();
      }
    });

    it('accepts a devnet-genesis endpoint', async () => {
      const c = new ExecutionCoordinator(conn(CLUSTER_GENESIS_HASH.devnet));
      vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(CLUSTER_GENESIS_HASH.devnet);
      vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
      vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(0);
      try {
        const res = await c.setRpcEndpoint('https://rpc.example.test/devnet');
        expect(res.success).toBe(true);
      } finally {
        c.cleanup();
      }
    });
  });

  describe('pump feed off mainnet', () => {
    it('pump.fun HTTP API events (mainnet data) never mark the feed healthy on devnet', () => {
      const c = new ExecutionCoordinator(conn(CLUSTER_GENESIS_HASH.devnet));
      try {
        c.recordPumpFeedEvent('PUMPFUN_SERVICE');
        expect((c as any).pumpFeedHealth).not.toBe('HEALTHY');
        expect((c as any).lastPumpFeedTimestamp).toBe(0);
        expect((c as any).lastRealMarketEventTimestamp).toBe(0);
        expect((c as any).lastMainnetApiTimestamp).toBeGreaterThan(0);
        c.recordPumpFeedEvent('PUMPFUN_STREAM');
        expect((c as any).pumpFeedHealth).toBe('HEALTHY');
      } finally {
        c.cleanup();
      }
    });

    it('on devnet a quiet pump feed does not block readiness; on mainnet it does', () => {
      const c = new ExecutionCoordinator(conn(CLUSTER_GENESIS_HASH.devnet));
      try {
        (c as any).startedAt = 0;
        const dev = c.canExecuteLive().reasons.join(' ');
        expect(dev).not.toMatch(/Pump\.fun real event stream/);
        expect(dev).not.toMatch(/Real on-chain market feed/);
        vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
        const main = c.canExecuteLive().reasons.join(' ');
        expect(main).toMatch(/Pump\.fun real event stream|Real on-chain market feed/);
      } finally {
        c.cleanup();
      }
    });

    it('on mainnet, PUMPFUN_SERVICE events do count', () => {
      vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
      const c = new ExecutionCoordinator(conn(CLUSTER_GENESIS_HASH.devnet));
      try {
        c.recordPumpFeedEvent('PUMPFUN_SERVICE');
        expect((c as any).pumpFeedHealth).toBe('HEALTHY');
      } finally {
        c.cleanup();
      }
    });
  });
});

describe('K6: POST /api/wallet/config path', () => {
  it('the schema no longer defaults rpcEndpoint (a save used to re-point the RPC at the public devnet URL)', () => {
    const parsed = WalletConfigSchema.parse({ walletAddress: 'So11111111111111111111111111111111111111112', enabledStrategies: {}, riskLimits: {} });
    expect(parsed.rpcEndpoint).toBeUndefined();
  });

  it('updateConfig rejects a mainnet RPC and leaves the stored endpoint and connection alone', async () => {
    const before = walletTrader.getState();
    const beforeEndpoint = (walletTrader as any).config.rpcEndpoint;
    const setSpy = vi.spyOn(executionCoordinator, 'setRpcEndpoint');
    await expect(walletTrader.updateConfig({ rpcEndpoint: 'https://api.mainnet-beta.solana.com' } as any)).rejects.toThrow(/RPC endpoint rejected: CLUSTER_GUARD/);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect((walletTrader as any).config.rpcEndpoint).toBe(beforeEndpoint);
    expect(walletTrader.getState().walletAddress).toBe(before.walletAddress);
  });

  it('a config save without rpcEndpoint does not touch the connection', async () => {
    const setSpy = vi.spyOn(executionCoordinator, 'setRpcEndpoint');
    vi.spyOn(solPriceService, 'refresh').mockResolvedValue(solPriceService.getPrice());
    await walletTrader.updateConfig({ allocatedSol: 0.07 } as any);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
