import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, EXIT_FAILURE_ALERT_AFTER } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';

/**
 * Q11: a halt must still let the operator's manual close through, whatever reason string the route passes.
 * Q12: results that mean "nothing was rejected" (a sell still being verified, no venue, no signer, zero quantity) must not advance
 * the retry ladder, the backoff or the EXIT_FAILING alert.
 */
const made: ExecutionCoordinator[] = [];
const make = () => { const c = new ExecutionCoordinator(false); made.push(c); return c; };
afterEach(() => { vi.restoreAllMocks(); while (made.length) made.pop()!.cleanup(); });

const paperPosition = (id: string) => workstationDb.savePosition({
  id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'Q11', name: 'Q11', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
  entryPriceSol: 0.0001, currentPriceSol: 0.0001, currentValueSol: 0.1, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN',
  venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `PAPER:${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
  recordUpdatedAt: Date.now(), updatedAt: Date.now(),
} as any);

describe('Q11: manual closes pass a halt', () => {
  it.each(['Manual user order', 'Aggregator Close', 'Operator close', 'MANUAL', 'Manual Close'])('close reason "%s" is not refused as TRADING_HALTED', async (reason) => {
    const c = make();
    const id = `q11-${Math.random().toString(36).slice(2)}`;
    paperPosition(id);
    c.haltAll('test halt');
    const res = await c.closePosition(id, 100, reason);
    expect(res.error ?? '').not.toMatch(/TRADING_HALTED/);
    expect(res.success).toBe(true);
  });

  it('a discretionary exit is still refused under the halt', async () => {
    const c = make();
    const id = `q11-${Math.random().toString(36).slice(2)}`;
    paperPosition(id);
    c.haltAll('test halt');
    expect((await c.closePosition(id, 100, 'TAKE_PROFIT_1')).error).toMatch(/TRADING_HALTED/);
  });
});

describe('Q12: waiting results do not walk the exit ladder', () => {
  const waiting = [
    'SELL_PENDING_VERIFICATION: sell abcd1234 was sent and is not confirmed or expired yet; not selling again',
    'UNKNOWN_TRADING_VENUE: Could not authoritatively determine whether token is bonding curve or PumpSwap pool in LIVE mode.',
    'Signer is not configured or locked',
    'Calculated sell quantity is zero',
  ];
  it.each(waiting)('"%s" leaves the failure count, slippage and alerts untouched', (error) => {
    const c = make();
    const before = c.exitSlippageBps('pos');
    for (let i = 0; i < EXIT_FAILURE_ALERT_AFTER + 2; i++) (c as any).recordExitOutcome('pos', { success: false, error }, 'LIVE');
    expect(c.getExitFailureCount('pos')).toBe(0);
    expect(c.exitSlippageBps('pos')).toBe(before);
    expect(c.exitRetryWaitMs('pos')).toBe(0);
    expect(c.getOperatorAlerts().some((a) => a.code === 'EXIT_FAILING')).toBe(false);
  });

  it('a real rejected send still advances the ladder and raises EXIT_FAILING', () => {
    const c = make();
    for (let i = 0; i < EXIT_FAILURE_ALERT_AFTER; i++) (c as any).recordExitOutcome('pos2', { success: false, error: 'Transaction simulation failed: slippage exceeded' }, 'LIVE');
    expect(c.getExitFailureCount('pos2')).toBe(EXIT_FAILURE_ALERT_AFTER);
    expect(c.exitSlippageBps('pos2')).toBeGreaterThan(800);
    expect(c.getOperatorAlerts().some((a) => a.code === 'EXIT_FAILING')).toBe(true);
  });
});

// Q11 over HTTP: the three operator close routes under a persisted halt (real server process, seeded PAPER positions, no chain involved)
import fs from 'node:fs';
import { WorkstationDatabase } from '../server/db/database';
import { startApp, startRpcStub, scratchDir, haltInSeparateProcess, LOCALNET_STUB_GENESIS } from './helpers/liveServer';

describe('Q11: every operator close route works under a halt', () => {
  it('/api/wallet/close-position, /api/memecoins/close and /api/execution/close close a position although all trading is halted', async () => {
    const dir = scratchDir('q11http-');
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    const ids = ['q11-a', 'q11-b', 'q11-c'];
    try {
      const db = new WorkstationDatabase(`${dir}/app.db`);
      const now = Date.now();
      for (const id of ids) db.savePosition({
        id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'Q11', name: 'Q11', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 1e-7, currentPriceSol: 1e-7,
        currentValueSol: 100, costBasisLamports: 100_000_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER',
        entryTxSignature: `PAPER:${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
      } as any);
      (db as any).db.close();
      haltInSeparateProcess(`${dir}/app.db`, 'q11 halt');
      const app = await startApp(dir, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
      try {
        expect((await app.call('POST', '/api/wallet/close-position', { positionId: ids[0], sellPct: 100 })).status).toBe(200);
        expect((await app.call('POST', '/api/memecoins/close', { positionId: ids[1], sellPct: 100 })).json.status).toBe('OK');
        expect((await app.call('POST', '/api/execution/close', { positionId: ids[2], sellPct: 100 })).status).toBe(200);
        const rows: any[] = (await app.call('GET', '/api/workstation/positions')).json.positions;
        expect(ids.map((id) => rows.find((p) => p.id === id)?.status)).toEqual(['CLOSED', 'CLOSED', 'CLOSED']);
      } finally { await app.stop(); }
    } finally { await rpc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
