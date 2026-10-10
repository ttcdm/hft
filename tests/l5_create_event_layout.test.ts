import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';

/**
 * L5: the CreateEvent decoder skipped `creator` and `timestamp`, so every reserve (and the launch price built from it) was
 * read from the wrong bytes. The fixture is the log of a REAL create_v2 transaction executed by the real pump program
 * on the localnet validator (scripts/localnet/e2e.ts, LOCALNET_DUMP_CREATE_LOG), with the program's own account values beside it.
 */
const fx = JSON.parse(fs.readFileSync('tests/fixtures/pump_create_v2_log.json', 'utf8'));

describe('L5: CreateEvent decoding follows the pump IDL', () => {
  it('decodes a real create_v2 log into exactly the reserves the program wrote', () => {
    const l = new PumpFeedListener();
    const ev = l.parseLogs({ err: null, signature: fx.signature, logs: fx.logs } as any, { slot: 7 })!;
    l.destroy();
    expect(ev).not.toBeNull();
    expect(ev.mint).toBe(fx.mint);
    expect(ev.creator).toBe(fx.creator);
    expect(typeof ev.user).toBe('string'); // R14: the create signer is decoded too
    expect(ev.user!.length).toBeGreaterThan(30);
    expect(ev.name).toBe('Localnet');
    expect(ev.symbol).toBe('LCL');
    expect(ev.virtualTokenReserves).toBe(BigInt(fx.chain.virtualTokenReserves));
    expect(ev.virtualSolReserves).toBe(BigInt(fx.chain.virtualSolReserves));
    expect(ev.realTokenReserves).toBe(BigInt(fx.chain.realTokenReserves));
    expect(ev.tokenTotalSupply).toBe(BigInt(fx.chain.tokenTotalSupply));
    expect(ev.initialPriceSol).toBeCloseTo(Number(ev.virtualSolReserves) / Number(ev.virtualTokenReserves) / 1000, 18);
  });

  it('distinct reserves survive the round trip (a decoder reading the wrong offsets cannot pass this)', () => {
    const mint = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
    const creator = new PublicKey('7xK9nMQk3mPzV1W8L5tG7yD2jX4vB6nS8cF9eR3tY1uQ');
    const log = PumpFeedListener.encodeCreateEventLog({
      name: 'N', symbol: 'S', uri: 'u', mint, creator,
      virtualTokenReserves: 1_111_111_111_111_111n, virtualSolReserves: 22_222_222_222n, realTokenReserves: 333_333_333_333_333n, tokenTotalSupply: 999_999_999_999_999n,
    });
    const l = new PumpFeedListener();
    const ev = l.parseLogs({ err: null, signature: 's', logs: PumpFeedListener.asPumpInvocation(log) } as any, { slot: 1 })!;
    l.destroy();
    expect([ev.virtualTokenReserves, ev.virtualSolReserves, ev.realTokenReserves, ev.tokenTotalSupply]).toEqual([1_111_111_111_111_111n, 22_222_222_222n, 333_333_333_333_333n, 999_999_999_999_999n]);
  });

  it('an event too short to carry its reserves is skipped, not filled with canonical numbers', () => {
    const buf = Buffer.concat([Buffer.from('1b72a94ddeeb6376', 'hex'), Buffer.alloc(4 + 4 + 4 + 32 * 3)]);
    const l = new PumpFeedListener();
    expect(l.parseLogs({ err: null, signature: 's', logs: PumpFeedListener.asPumpInvocation(`Program data: ${buf.toString('base64')}`) } as any, { slot: 1 })).toBeNull();
    l.destroy();
  });
});
