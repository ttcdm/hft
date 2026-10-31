import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WorkstationDatabase, workstationDb } from '../server/db/database';
import { computeJournalStats } from '../server/auto/journalStats';
import { autoSnipeController } from '../server/auto/controller';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';
import { resetAuto } from './fixtures/auto';

/**
 * R12-5 (server half): the stats left KILL_TRIGGER rows out ("Dropped / rejected by stage" showed "—"), and KILL AUTO never said that
 * positions opened by hand stay open. R13-14 (first bullet): POST /api/auto/kill without exitAll answered success:true, stillOpen:0 while
 * auto positions stayed open. Real journal stats, controller and (for the reply) the real server over HTTP.
 */
function seed(db: WorkstationDatabase, id: string, autoOwned: boolean): void {
  const now = Date.now();
  db.savePosition({
    id, mint: Keypair.generate().publicKey.toBase58(), symbol: id.slice(0, 6), name: id, tokenDecimals: 6, tokenQuantityRaw: '1000000000',
    entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0.0001, costBasisLamports: 100_000, realizedPnLSol: 0, status: 'OPEN',
    venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: id, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
  } as any);
  if (autoOwned) db.logDecision({ autoMode: 'PAPER', mint: 'm', stage: 'fill', outcome: 'BOUGHT', reason: 'seeded', positionId: id });
}

describe('R12-5: journal stats count the KILL_TRIGGER rows', () => {
  it('a KILL_TRIGGER row is counted, under "kill trigger"', () => {
    const s = computeJournalStats([
      { stage: 'risk', outcome: 'KILL_TRIGGER', positionId: null, solDelta: null, inputs: {} },
      { stage: 'watch', outcome: 'DROPPED', positionId: null, solDelta: null, inputs: {} },
    ], () => undefined);
    expect(s.killTriggers).toBe(1);
    expect(s.rejectedByStage).toEqual({ watch: 1, 'kill trigger': 1 });
  });
});

describe('R12-5 / R13-14: the kill result counts what is still open', () => {
  afterEach(async () => {
    await resetAuto();
    workstationDb.setSetting('auto.kill', null);
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
  });

  it('without exitAll: stillOpen is the auto positions left open, manualOpen the hand-opened ones', async () => {
    seed(workstationDb, `r1314-auto-${Date.now()}`, true);
    seed(workstationDb, `r125-manual-${Date.now()}`, false);
    const r = await autoSnipeController.kill({ reason: 'r13-14' });
    expect(r.attempted).toBe(0);
    expect(r.stillOpen).toBe(1);
    expect(r.manualOpen).toBe(1);
  });
});

describe('R12-5 / R13-14: POST /api/auto/kill says what stays open', () => {
  let rpc: RpcStub; let app: AppHandle; let d: string;
  beforeAll(async () => {
    d = scratchDir('r1314-http-');
    rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    const db = new WorkstationDatabase(`${d}/app.db`);
    seed(db, 'r1314-http-auto', true);
    seed(db, 'r125-http-manual', false);
    (db as any).db.close();
    app = await startApp(d, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
  }, 120_000);
  afterAll(async () => {
    await app?.stop();
    rpc?.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('without exitAll: success:false, stillOpen 1, and a note about the manual position', async () => {
    const r = await app.call('POST', '/api/auto/kill', { reason: 'r13-14 http' });
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe('OFF');
    expect(r.json.success).toBe(false);
    expect(r.json.stillOpen).toBe(1);
    expect(r.json.manualOpen).toBe(1);
    expect(r.json.error).toMatch(/Nothing was sold/);
    expect(r.json.note).toMatch(/1 position\(s\) you opened by hand are still open/);
  });
});
