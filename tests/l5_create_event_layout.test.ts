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

  it('distinct reserves are read from the IDL offsets (bytes laid out here by hand, not by the production encoder)', () => {
    // T5: the old version encoded with PumpFeedListener.encodeCreateEventLog and decoded with the same module, so a shared offset
    // bug passed. This lays the bytes out from the pump IDL independently: disc, 3 length-prefixed strings, mint, bonding_curve,
    // user, creator, i64 timestamp, then virtual_token, virtual_sol, real_token, token_total_supply as u64 LE.
    const mint = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
    const curve = new PublicKey('7xK9nMQk3mPzV1W8L5tG7yD2jX4vB6nS8cF9eR3tY1uQ');
    const user = new PublicKey('4Nd1mBQtrMJVYVfKGfVtaTgnxC7yJrBPJ5U1s5j9Pump');
    const creator = new PublicKey('11111111111111111111111111111112');
    const str = (v: string) => { const b = Buffer.from(v, 'utf8'); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, b]); };
    const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
    const ts = Buffer.alloc(8); ts.writeBigInt64LE(1_700_000_000n);
    const data = Buffer.concat([
      Buffer.from('1b72a94ddeeb6376', 'hex'), str('Name'), str('SYM'), str('https://u'),
      mint.toBuffer(), curve.toBuffer(), user.toBuffer(), creator.toBuffer(), ts,
      u64(1_111_111_111_111_111n), u64(22_222_222_222n), u64(333_333_333_333_333n), u64(999_999_999_999_999n),
    ]);
    const l = new PumpFeedListener();
    const ev = l.parseLogs({ err: null, signature: 's', logs: PumpFeedListener.asPumpInvocation(`Program data: ${data.toString('base64')}`) } as any, { slot: 1 })!;
    l.destroy();
    expect(ev).not.toBeNull();
    expect([ev.name, ev.symbol, ev.mint, ev.creator, ev.user]).toEqual(['Name', 'SYM', mint.toBase58(), creator.toBase58(), user.toBase58()]);
    expect([ev.virtualTokenReserves, ev.virtualSolReserves, ev.realTokenReserves, ev.tokenTotalSupply]).toEqual([1_111_111_111_111_111n, 22_222_222_222n, 333_333_333_333_333n, 999_999_999_999_999n]);
  });

  it('an event too short to carry its reserves is skipped, not filled with canonical numbers', () => {
    const buf = Buffer.concat([Buffer.from('1b72a94ddeeb6376', 'hex'), Buffer.alloc(4 + 4 + 4 + 32 * 3)]);
    const l = new PumpFeedListener();
    expect(l.parseLogs({ err: null, signature: 's', logs: PumpFeedListener.asPumpInvocation(`Program data: ${buf.toString('base64')}`) } as any, { slot: 1 })).toBeNull();
    l.destroy();
  });
});
