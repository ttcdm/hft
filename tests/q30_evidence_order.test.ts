import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WorkstationDatabase } from '../server/db/database';
import { upperBound80, Z_80 } from '../server/auto/killSwitch';

describe('Q30', () => {
  it('evidence trades come back oldest first, so "the last 20" are the latest 20', async () => {
    const db = new WorkstationDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q30-')), 'q30.db'));
    for (const id of ['a', 'b', 'c']) {
      db.savePosition({ id, mint: Keypair.generate().publicKey.toBase58(), symbol: id, name: id, tokenDecimals: 6, tokenQuantityRaw: '0', costBasisLamports: 1e6,
        entryPriceSol: 1, currentPriceSol: 1, realizedPnLSol: 0.001, entryTxSignature: `sig-${id}`, entryTimestamp: 1000 + (id === 'a' ? 3 : id === 'b' ? 2 : 1), // entry order is c, b, a
        executionMode: 'PAPER', status: 'CLOSED' } as any);
      await new Promise((r) => setTimeout(r, 5)); // closed in the order a, b, c
    }
    expect(db.loadEvidenceClosedTrades('PAPER').map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('the 80% bound uses the 80% quantile', () => {
    expect(Z_80).toBeCloseTo(0.8416, 4);
    expect(upperBound80([0, 2])).toBeCloseTo(1 + 0.8416, 4);
  });
});
