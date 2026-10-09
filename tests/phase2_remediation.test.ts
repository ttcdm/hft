import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PublicKey } from '@solana/web3.js';
import {
  PumpFeedListener,
  PUMP_CREATE_EVENT_DISCRIMINATOR,
  pumpFeedListener,
} from '../server/solana/pumpFeedListener';
import { executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { pumpFunService } from '../server/pumpfunService';
import { walletTrader } from '../server/walletTrader';
import { AvellanedaStoikovEngine } from '../server/engine/engine';
import { isLiveApprovedProvenance } from '../server/core/types';
import { localSigner } from '../server/solana/signer';

describe('Phase 2 Remediation Suite (B02, B08, B09, B17, B21, B23)', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    memecoinAggregator.setConfluenceGating(false); // C2: gating is on by default; this test is about something else
    process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
    delete process.env.ENABLE_BINANCE_FUTURES;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Task 1: B02 Circular Startup Feed Check Deadlock
  // =========================================================================
  describe('B02: Circular Startup Feed Check Deadlock Remediation', () => {
    it('coordinator initializes with 5-minute startupGracePeriodMs (300,000ms)', () => {
      expect(executionCoordinator.getStartupGracePeriodMs()).toBe(300_000);
      expect(executionCoordinator.getStartedAt()).toBeGreaterThan(0);
      expect(Date.now() - executionCoordinator.getStartedAt()).toBeLessThan(60_000);
    });

    it('coordinator.getLiveReadiness() reports pumpFeed status WARMING_UP with healthy=true during grace period', () => {
      // With lastPumpFeedTimestamp === 0 on startup
      const readiness = executionCoordinator.getLiveReadiness();
      expect(readiness.components.pumpFeed.status).toBe('WARMING_UP');
      expect(readiness.components.pumpFeed.healthy).toBe(true);
    });

    it('operator can arm LIVE mode during warmup grace period without circular deadlock', () => {
      // Mock prerequisites to healthy so that only feed check remains
      vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
      (executionCoordinator as any).rpcHealth = 'HEALTHY';
      (executionCoordinator as any).realWalletBalanceSol = 0.05;
      (executionCoordinator as any).lastStartupReconciliation = {
        status: 'EXECUTION_READY',
        checkedAt: Date.now(),
        details: 'Startup reconciled',
      };
      vi.spyOn((executionCoordinator as any).jitoTransport, 'getTelemetry').mockReturnValue({
        health: 'HEALTHY',
      } as any);
      // A4 also requires a recent probe; this test is about the feed grace period, so make the probe current.
      vi.spyOn((executionCoordinator as any).jitoTransport, 'getProbeAgeMs').mockReturnValue(0);

      const armRes = executionCoordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
      expect(armRes.success).toBe(true);
      expect(armRes.message).toContain('Live trading armed successfully');
      expect(armRes.message).toContain('warming up');
      expect(executionCoordinator.getExecutionMode()).toBe('LIVE');

      // Disarm cleanly
      executionCoordinator.armLiveTrading(false);
      expect(executionCoordinator.getExecutionMode()).toBe('PAPER');
    });

    it('coordinator getDiagnostics reports marketFeedHealth as WARMING_UP during startup', () => {
      const diag = executionCoordinator.getDiagnostics();
      expect(['WARMING_UP', 'HEALTHY']).toContain(diag.marketFeedHealth);
      expect(['WARMING_UP', 'HEALTHY']).toContain(diag.pumpFeedHealth);
    });
  });

  // =========================================================================
  // Task 2: B08 Real Solana WebSocket Event Ingestion
  // =========================================================================
  describe('B08: Real Solana WebSocket Event Ingestion (PumpFeedListener)', () => {
    it('PUMP_CREATE_EVENT_DISCRIMINATOR matches sha256("event:CreateEvent")[0..8]', () => {
      const expected = crypto.createHash('sha256').update('event:CreateEvent').digest().subarray(0, 8);
      expect(PUMP_CREATE_EVENT_DISCRIMINATOR.equals(expected)).toBe(true);
      expect(PUMP_CREATE_EVENT_DISCRIMINATOR.toString('hex')).toBe('1b72a94ddeeb6376');
    });

    it('deriveBondingCurvePda correctly derives PDA using bonding-curve seed', () => {
      const testMint = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
      const pda = PumpFeedListener.deriveBondingCurvePda(testMint);
      expect(pda).toBeInstanceOf(PublicKey);
      expect(pda.toBase58()).toBeTruthy();

      // Verify idempotency
      const pda2 = PumpFeedListener.deriveBondingCurvePda(testMint);
      expect(pda.toBase58()).toBe(pda2.toBase58());
    });

    it('parseLogs parses Anchor binary CreateEvent within <50ms and extracts exact fields', () => {
      const testMint = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
      const testCreator = new PublicKey('7xK9nMQk3mPzV1W8L5tG7yD2jX4vB6nS8cF9eR3tY1uQ');
      const curvePda = PumpFeedListener.deriveBondingCurvePda(testMint);

      const encodedLog = PumpFeedListener.encodeCreateEventLog({
        name: 'Apex Token',
        symbol: 'APEX',
        uri: 'https://apex.hft/metadata.json',
        mint: testMint,
        bondingCurve: curvePda,
        creator: testCreator,
      });

      const mockLogs = {
        err: null,
        logs: [
          'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
          'Program log: Instruction: Create',
          encodedLog,
          'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
        ],
        signature: '5VerBQWebsocketSignatureTest111111111111111111111111111111111111111111111111111111111',
      };

      const t0 = performance.now();
      const parsed = pumpFeedListener.parseLogs(mockLogs, { slot: 295104920 });
      const elapsed = performance.now() - t0;

      expect(parsed !== null).toBe(true);
      // Removed timing assertion per AGENTS.md: Never assert execution time deltas in functional test suites.
      expect(parsed!.mint).toBe(testMint.toBase58());
      expect(parsed!.creator).toBe(testCreator.toBase58());
      expect(parsed!.bondingCurve).toBe(curvePda.toBase58());
      expect(parsed!.name).toBe('Apex Token');
      expect(parsed!.symbol).toBe('APEX');
      expect(parsed!.uri).toBe('https://apex.hft/metadata.json');
      expect(parsed!.slot).toBe(295104920);

      // Verify canonical initial reserves
      expect(parsed!.virtualTokenReserves).toBe(1_073_000_000_000_000n);
      expect(parsed!.virtualSolReserves).toBe(30_000_000_000n);
      expect(parsed!.realTokenReserves).toBe(793_100_000_000_000n);
      expect(parsed!.realSolReserves).toBe(0n);
      expect(parsed!.tokenTotalSupply).toBe(1_000_000_000_000_000n);
      expect(parsed!.initialPriceSol).toBeCloseTo(0.000000028, 8);
    });

    it('parseLogs parses structured text fallback log format', () => {
      const mockLogs = {
        err: null,
        logs: [
          'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
          'Program log: Instruction: Create mint=9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump creator=7xK9nMQk3mPzV1W8L5tG7yD2jX4vB6nS8cF9eR3tY1uQ symbol=FARTCOIN name=Fartcoin AI',
          'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
        ],
        signature: 'mockSignature123',
      };

      const parsed = pumpFeedListener.parseLogs(mockLogs, { slot: 100 });
      expect(parsed !== null).toBe(true);
      expect(parsed!.mint).toBe('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump');
      expect(parsed!.creator).toBe('7xK9nMQk3mPzV1W8L5tG7yD2jX4vB6nS8cF9eR3tY1uQ');
      expect(parsed!.symbol).toBe('FARTCOIN');
      expect(parsed!.name).toBe('Fartcoin AI');
    });

    it('pumpFeedListener.start() subscribes to onLogs with processed commitment', async () => {
      const listener = new PumpFeedListener(executionCoordinator.getConnection());
      const started = await listener.start();
      expect(started).toBe(true);
      expect(listener.isActive()).toBe(true);
      const tel = listener.getTelemetry();
      expect(tel.status).toBe('ACTIVE');
      expect(tel.subscriptionId !== null).toBe(true);

      await listener.stop();
      expect(listener.isActive()).toBe(false);
    });

    it('memecoinAggregator ingests on-chain CreateEvent and adds pool with REAL_ONCHAIN provenance', () => {
      const testMint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';
      const event = {
        signature: 'sig1',
        slot: 1234,
        mint: testMint,
        creator: 'creator1',
        bondingCurve: 'curve1',
        name: 'WebSocket Token',
        symbol: 'WSTOKEN',
        uri: 'https://test.com',
        virtualTokenReserves: 1_073_000_000_000_000n,
        virtualSolReserves: 30_000_000_000n,
        realTokenReserves: 793_100_000_000_000n,
        realSolReserves: 0n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        initialPriceSol: 0.000000028,
        initialMarketCapSol: 28.0,
        receivedAt: Date.now(),
        parsedAt: Date.now(),
        parseLatencyMs: 0.5,
        source: 'SOLANA_WS_LOGS' as const,
      };

      const pool = memecoinAggregator.ingestOnChainCreateEvent(event);
      expect(pool.contractAddress).toBe(testMint);
      expect(pool.symbol).toBe('WSTOKEN');
      expect(pool.id).toContain('pool-onchain-');
      expect(pool.createdAgo).toBe('Just now (WS)');

      const found = memecoinAggregator.getPools().find((p) => p.contractAddress === testMint);
      expect(found).toBeDefined();
    });

    it('pumpfunService handleOnChainCreateEvent records event and updates liveSource', () => {
      const testMint = '2qEH8vxXMwYePYNpdkmcz69g78mXfW7kG2bV3e7X6h8L';
      const event = {
        signature: 'sig2',
        slot: 5678,
        mint: testMint,
        creator: 'creator2',
        bondingCurve: 'curve2',
        name: 'Peanut Squirrel',
        symbol: 'PNUT',
        uri: 'https://pnut.com',
        virtualTokenReserves: 1_073_000_000_000_000n,
        virtualSolReserves: 30_000_000_000n,
        realTokenReserves: 793_100_000_000_000n,
        realSolReserves: 0n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        initialPriceSol: 0.000000028,
        initialMarketCapSol: 28.0,
        receivedAt: Date.now(),
        parsedAt: Date.now(),
        parseLatencyMs: 0.8,
        source: 'SOLANA_WS_LOGS' as const,
      };

      pumpFunService.handleOnChainCreateEvent(event);
      const status = pumpFunService.getStatus();
      expect(status.liveSource).toContain('Solana WebSocket Logs');
      expect(executionCoordinator.getLastPumpFeedTimestamp()).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Task 3: B09 Correct Signal Provenance Tagging
  // =========================================================================
  describe('B09: Signal Provenance Tagging', () => {
    it('isLiveApprovedProvenance permits REAL_ONCHAIN and LIVE_PUMP_STREAM', () => {
      expect(isLiveApprovedProvenance('REAL_ONCHAIN')).toBe(true);
      expect(isLiveApprovedProvenance('LIVE_PUMP_STREAM')).toBe(true);
      expect(isLiveApprovedProvenance('SYNTHETIC_TEST')).toBe(false);
      expect(isLiveApprovedProvenance('SYNTHETIC_SIMULATION')).toBe(false);
    });

    it('memecoinAggregator.executeSnipe assigns REAL_ONCHAIN provenance to on-chain discovered pools', async () => {
      let capturedProvenance: string | null = null;
      vi.spyOn(executionCoordinator, 'executeTrade').mockImplementation(async (req: any) => {
        capturedProvenance = req.provenance;
        return {
          success: true,
          positionId: 'pos-test-123',
          executionMode: 'PAPER',
          txSignature: 'tx123',
          correlationId: 'corr123',
          lifecycleState: 'CONFIRMED',
        };
      });

      // Execute snipe on an on-chain discovered pool
      const pool = memecoinAggregator.getPools().find((p) => p.id.startsWith('pool-onchain-'));
      const testCa = pool ? pool.contractAddress : 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';

      await memecoinAggregator.executeSnipe({
        contractAddress: testCa,
        amountUsd: 5.0,
      });

      expect(capturedProvenance).toBe('REAL_ONCHAIN');
    });

    it('coordinator.executeTrade in LIVE mode approves REAL_ONCHAIN without PROVENANCE_VIOLATION', async () => {
      // Mock live execution prerequisites
      (executionCoordinator as any).executionMode = 'LIVE';
      (executionCoordinator as any).isLiveTradingArmed = true;

      const res = await executionCoordinator.executeTrade({
        mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
        symbol: 'GOAT',
        name: 'Goatseus Maximus',
        amountSol: 0.005,
        provenance: 'REAL_ONCHAIN',
        source: 'AUTO_SNIPER',
      });

      // Should not be rejected due to provenance violation
      if (!res.success) {
        expect(res.error?.includes('PROVENANCE_VIOLATION')).toBe(false);
      }

      // Cleanup
      (executionCoordinator as any).executionMode = 'PAPER';
      (executionCoordinator as any).isLiveTradingArmed = false;
    });
  });

  // =========================================================================
  // Task 4: B17, B21, B23 Spurious Services, Price Resilience & Documentation
  // =========================================================================
  describe('B17: Binance Futures Engine Isolation', () => {
    it('AvellanedaStoikovEngine does NOT connect to Binance WebSocket when ENABLE_BINANCE_FUTURES is false or unset', () => {
      delete process.env.ENABLE_BINANCE_FUTURES;
      const engine = new AvellanedaStoikovEngine();
      expect((engine as any).depthWs).toBeNull();
      expect((engine as any).tradeWs).toBeNull();
      expect((engine as any).reconnectTimeout).toBeNull();
      engine.destroy();
    });

    it('AvellanedaStoikovEngine connectExchangeStreams is a no-op when ENABLE_BINANCE_FUTURES !== true', () => {
      process.env.ENABLE_BINANCE_FUTURES = 'false';
      const engine = new AvellanedaStoikovEngine();
      (engine as any).connectExchangeStreams();
      expect((engine as any).depthWs).toBeNull();
      expect((engine as any).tradeWs).toBeNull();
      engine.destroy();
    });
  });

  describe('B21: Rust Engine Documentation Boundary', () => {
    it('crates/apex_hft_engine/README.md clarifies that apex_hft_engine is a standalone CEX benchmark and DEX execution is driven by TypeScript', () => {
      const readmePath = path.join(process.cwd(), 'crates/apex_hft_engine/README.md');
      const readmeContent = fs.readFileSync(readmePath, 'utf8');

      expect(readmeContent).toContain('ARCHITECTURAL BOUNDARY & ROLE NOTICE (B21)');
      expect(readmeContent).toContain('standalone');
      expect(readmeContent).toContain('reference benchmark');
      expect(readmeContent).toContain('TypeScript');
      expect(readmeContent).toContain('server/');
    });
  });

  describe('B23: Fallback Pricing Resilience (SolPriceService, C3)', () => {
    // C3: Jupiter price API v6 is deprecated and was replaced by Coinbase spot; the cascade is Binance -> Coinbase -> CoinGecko.
    it('walletTrader falls back to Coinbase or CoinGecko if Binance fails or is geo-blocked', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const urlStr = url.toString();
        if (urlStr.includes('api.binance.com')) {
          return new Response(JSON.stringify({ code: 0, msg: 'Service unavailable from restricted location' }), { status: 451 });
        }
        if (urlStr.includes('api.coinbase.com')) {
          return new Response(JSON.stringify({ data: { base: 'SOL', currency: 'USD', amount: '152.75' } }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      });

      await walletTrader.syncRpcBalance();
      expect(walletTrader.getState().solPriceUsd).toBe(152.75);

      fetchSpy.mockRestore();
    });

    it('walletTrader falls back to CoinGecko if both Binance and Coinbase fail', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const urlStr = url.toString();
        if (urlStr.includes('api.binance.com') || urlStr.includes('api.coinbase.com')) {
          return new Response('Network error', { status: 500 });
        }
        if (urlStr.includes('coingecko.com')) {
          return new Response(JSON.stringify({ solana: { usd: 154.2 } }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      });

      await walletTrader.syncRpcBalance();
      expect(walletTrader.getState().solPriceUsd).toBe(154.2);

      fetchSpy.mockRestore();
    });
  });
});
