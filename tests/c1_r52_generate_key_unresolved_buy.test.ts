import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import { WorkstationDatabase } from '../server/db/database';
import { scratchDir, startApp, type AppHandle } from './helpers/liveServer';

/**
 * R5-2: the replacement-key guard of POST /api/signer/generate counted only ACTIVE LIVE positions. A LIVE buy that was sent and is not
 * resolved can still become a position bought by the current wallet, so a new key must not be generated while one exists. Real server
 * process on a scratch database and a key path that does not exist; no network.
 */
const handles: AppHandle[] = [];
afterEach(async () => { while (handles.length) await handles.pop()!.stop(); });

describe('R5-2: no new signing key while a LIVE buy is unresolved', () => {
  it('answers 409 and writes no key file when the ledger holds an unresolved LIVE buy and no open position', async () => {
    const dir = scratchDir('c1r52-');
    const dbPath = path.join(dir, 'app.db');
    const keyFile = path.join(dir, 'never-created.json');
    const seed = new WorkstationDatabase(dbPath);
    seed.saveTransaction({ signature: `r52_${Date.now()}`, orderId: 'o', correlationId: 'c', mint: Keypair.generate().publicKey.toBase58(), direction: 'BUY', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now(), reconciliationState: 'RECONCILIATION_REQUIRED', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' } as any);
    (seed as any).db.close();
    const app = await startApp(dir, { APEX_DB_PATH: dbPath, SIGNER_KEYPAIR_PATH: keyFile });
    handles.push(app);
    const res = await app.call('POST', '/api/signer/generate', {});
    expect(res.status).toBe(409);
    expect(String(res.json?.error)).toMatch(/unresolved LIVE buys/);
    expect(fs.existsSync(keyFile)).toBe(false);
  }, 120_000);
});
