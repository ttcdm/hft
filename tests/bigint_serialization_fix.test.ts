import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pumpFeedListener, PumpCreateEvent } from '../server/solana/pumpFeedListener';
import { Logger } from '../server/middleware/enterprise';
import { workstationDb } from '../server/db/database';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { pumpFunService } from '../server/pumpfunService';

describe('BigInt Serialization & PumpFeedListener Event Handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Logger handles context containing BigInts without throwing TypeError', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => {
      Logger.info('Testing BigInt logging', {
        reserves: 1_073_000_000_000_000n,
        solAmount: 30_000_000_000n,
      });
    }).not.toThrow();

    expect(() => {
      Logger.warn('Testing BigInt warning', {
        reserves: 1_073_000_000_000_000n,
      });
    }).not.toThrow();

    expect(consoleSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('Database logJournal handles payloads containing BigInts without error', () => {
    expect(() => {
      workstationDb.logJournal('TEST_EVENT', 'corr-123', 'PAPER', {
        virtualTokenReserves: 1_073_000_000_000_000n,
        virtualSolReserves: 30_000_000_000n,
      });
    }).not.toThrow();
  });

  it('pumpFeedListener emits create_event with BigInt reserves and consumers process it safely', () => {
    const testEvent: PumpCreateEvent = {
      signature: 'testSig1234567890',
      slot: 300000000,
      mint: 'TestMintAddress11111111111111111111111111111',
      creator: 'TestCreatorAddress111111111111111111111111111',
      bondingCurve: 'TestBondingCurve111111111111111111111111111',
      name: 'Test BigInt Token',
      symbol: 'TBINT',
      uri: 'https://example.com/metadata.json',
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualSolReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realSolReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      initialPriceSol: 0.000000028,
      initialMarketCapSol: 28,
      receivedAt: Date.now(),
      parsedAt: Date.now(),
      parseLatencyMs: 1.5,
      source: 'TEST_FEED',
    };

    let received = false;
    const testListener = (evt: PumpCreateEvent) => {
      received = true;
      expect(evt.virtualTokenReserves).toBe(1_073_000_000_000_000n);
      // Verify JSON.stringify with BigInt replacer works
      const jsonStr = JSON.stringify(evt, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      expect(jsonStr).toContain('1073000000000000');
    };

    pumpFeedListener.on('create_event', testListener);

    expect(() => {
      pumpFeedListener.emit('create_event', testEvent);
    }).not.toThrow();

    expect(received).toBe(true);
    pumpFeedListener.off('create_event', testListener);
  });

  it('memecoinAggregator ingestOnChainCreateEvent and pumpfunService handleOnChainCreateEvent process BigInt event cleanly', () => {
    const testEvent: PumpCreateEvent = {
      signature: 'testSig999',
      slot: 300000001,
      mint: 'TestMintAddress22222222222222222222222222222',
      creator: 'TestCreatorAddress222222222222222222222222222',
      bondingCurve: 'TestBondingCurve222222222222222222222222222',
      name: 'Ingest Test Token',
      symbol: 'INGEST',
      uri: 'https://example.com/meta2.json',
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualSolReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realSolReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      initialPriceSol: 0.000000028,
      initialMarketCapSol: 28,
      receivedAt: Date.now(),
      parsedAt: Date.now(),
      parseLatencyMs: 0.8,
      source: 'TEST_FEED',
    };

    expect(() => {
      const pool = memecoinAggregator.ingestOnChainCreateEvent(testEvent);
      expect(pool).toBeDefined();
      expect(pool.contractAddress).toBe('TestMintAddress22222222222222222222222222222');
    }).not.toThrow();

    expect(() => {
      pumpFunService.handleOnChainCreateEvent(testEvent);
    }).not.toThrow();
  });
});
