import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WorkstationDatabase } from '../server/db/database';
import { startApp, startRpcStub, scratchDir, haltInSeparateProcess, LOCALNET_STUB_GENESIS, MAINNET_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';

/**
 * Round 6 (haiku-attack 2026-10-26), over the real server's HTTP API: what the code knows reaches the operator.
 * R6-1 / R7-1: GET /api/system/checks serves the open operator alerts, with a level, as the runbook says.
 * R6-4: POST /api/auto/kill with exitAll answers success:false when a sell of what auto bought is refused.
 * R6-2: GET /api/wallet/state lists an open LIVE position while the server is in PAPER.
 */
const dirs: string[] = [];
const handles: Array<{ stop(): Promise<void> }> = [];
afterAll(async () => {
  for (const h of handles) await h.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const dir = () => { const d = scratchDir('r6-http-'); dirs.push(d); return d; };

describe('R6-1/R7-1: /api/system/checks serves the operator alerts', () => {
  let rpc: RpcStub; let app: AppHandle;
  beforeAll(async () => {
    const d = dir();
    rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    haltInSeparateProcess(`${d}/app.db`, 'r6 http halt'); // the next boot raises TRADING_HALTED from the journal
    app = await startApp(d, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
    handles.push(app);
  }, 120_000);
  afterAll(() => rpc.close());

  it('the restored halt is listed as a CRITICAL operator alert and the alerts row is FAIL; clearing the halt removes it', async () => {
    const r = await app.call('GET', '/api/system/checks');
    expect(r.status).toBe(200);
    const halted = r.json.operatorAlerts.find((a: any) => a.code === 'TRADING_HALTED');
    expect(halted.level).toBe('CRITICAL');
    expect(halted.message).toMatch(/r6 http halt/);
    expect(r.json.checks.find((c: any) => c.id === 'alerts').status).toBe('FAIL');
    await app.call('POST', '/api/auto/resume', { clearHalt: true });
    const after = (await app.call('GET', '/api/system/checks')).json;
    expect(after.operatorAlerts.some((a: any) => a.code === 'TRADING_HALTED')).toBe(false);
  });

  it('UI fix 5: /api/diagnostics/system names the key file the signer really uses, not a fixed .apex_trading_keypair.json', async () => {
    const a = (await app.call('GET', '/api/diagnostics/system')).json.systemAudit;
    expect(a.signerKeySource).toBe('FILE');
    expect(a.signerKeyPath).toMatch(/r6-http-[^/]+\/throwaway\.json$/);
    expect(a.keypairStorage).toContain(a.signerKeyPath);
    expect(a.keypairStorage).not.toContain('.apex_trading_keypair.json');
  });
});

describe('R6-4 / R6-2: kill auto reports refused sells; an open LIVE position shows while the server is in PAPER', () => {
  let rpc: RpcStub; let app: AppHandle;
  const positionId = 'r64-http-live-1';
  beforeAll(async () => {
    const d = dir();
    rpc = await startRpcStub(MAINNET_GENESIS); // ALLOWED_CLUSTER=mainnet-beta: every send is refused, so the close of the LIVE position fails
    const db = new WorkstationDatabase(`${d}/app.db`);
    const now = Date.now();
    const mint = Keypair.generate().publicKey.toBase58();
    db.savePosition({
      id: positionId, mint, symbol: 'R64', name: 'R6-4 kill', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
      entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0.0001, costBasisLamports: 100_000, realizedPnLSol: 0, status: 'OPEN',
      venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: 'R64SeededEntry', entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
    } as any);
    db.logDecision({ autoMode: 'DEVNET_LIVE', mint, symbol: 'R64', stage: 'buy', outcome: 'BOUGHT', reason: 'seeded', positionId });
    (db as any).db.close();
    app = await startApp(d, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'mainnet-beta', LOCALNET_GENESIS_HASH: '', ALLOW_LIVE_REAL_MONEY_TRADING: 'true' });
    handles.push(app);
  }, 120_000);
  afterAll(() => rpc.close());

  it('the server is in PAPER and /api/wallet/state still lists the LIVE position, in liveOpen', async () => {
    const st = (await app.call('GET', '/api/wallet/state')).json.data;
    expect(st.executionMode).toBe('PAPER');
    expect(st.liveOpen.count).toBe(1);
    expect(st.activePositions.find((p: any) => p.id === positionId).executionMode).toBe('LIVE');
  });

  it('KILL AUTO with exitAll answers success:false and names the position that was not sold', async () => {
    const r = await app.call('POST', '/api/auto/kill', { exitAll: true, reason: 'r6-4 http' });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(false);
    expect(r.json.mode).toBe('OFF');
    expect(r.json.attempted).toBe(1);
    expect(r.json.closed).toBe(0);
    // the wrong-cluster sell is refused before anything is sent, so it is in `refused`; it is still open
    const notSold = [...r.json.refused, ...r.json.failed];
    expect(notSold).toHaveLength(1);
    expect(notSold[0].positionId).toBe(positionId);
    expect(notSold[0].error).toMatch(/CLUSTER_GUARD/);
    expect(r.json.stillOpen).toBe(1);
    expect(r.json.error).toMatch(/NOT sold/);
  });
});
