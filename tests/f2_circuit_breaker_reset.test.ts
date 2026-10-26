import net from 'node:net';
import { describe, it, expect, vi, afterEach, afterAll, beforeAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { HardenedRiskEngine, riskEngine } from '../server/risk/riskEngine';
import { executionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { authManager } from '../server/middleware/auth';
import { buildSystemChecks } from '../server/system/systemChecks';
import { workstationDb } from '../server/db/database';

/**
 * F2: the risk circuit breaker opened after three failed wallet-balance reads and nothing ever closed it, so LIVE stayed blocked until a
 * restart. Mike chose a manual reset: the kill-switch reset closes it, but only when the latest balance read succeeded. Fails on the
 * code before the fix (no resetCircuitBreaker, and the route left the breaker OPEN whatever the reads did).
 */
afterEach(() => vi.restoreAllMocks());

describe('HardenedRiskEngine.resetCircuitBreaker', () => {
  it('closes an open breaker once a balance read has succeeded since the failures', () => {
    const risk = new HardenedRiskEngine();
    for (let i = 0; i < 3; i++) risk.recordRpcFailure();
    expect(risk.getCircuitBreakerState()).toBe('OPEN');
    risk.recordRpcSuccess();
    const r = risk.resetCircuitBreaker();
    expect(r.closed).toBe(true);
    expect(risk.getCircuitBreakerState()).toBe('CLOSED');
  });

  it('leaves it open, with the reason, while the latest read is a failure', () => {
    const risk = new HardenedRiskEngine();
    for (let i = 0; i < 3; i++) risk.recordRpcFailure();
    risk.recordRpcSuccess();
    risk.recordRpcFailure(); // the RPC failed again after one good read
    const r = risk.resetCircuitBreaker();
    expect(r.closed).toBe(false);
    expect(r.reason).toMatch(/latest wallet balance read failed/);
    expect(risk.getCircuitBreakerState()).toBe('OPEN');
  });

  it('never closes by itself: good reads alone leave it open until the reset', () => {
    const risk = new HardenedRiskEngine();
    for (let i = 0; i < 3; i++) risk.recordRpcFailure();
    for (let i = 0; i < 5; i++) risk.recordRpcSuccess();
    expect(risk.getCircuitBreakerState()).toBe('OPEN');
  });
});

describe('POST /api/execution/kill-switch {activate:false} on the real server, driven by real balance reads', () => {
  let base = '';
  let token = '';
  let httpServer: import('node:http').Server;
  beforeAll(async () => {
    const mod = await import('../server');
    httpServer = mod.server;
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}`;
    token = authManager.createSession('OPERATOR').token;
  }, 60_000);
  afterAll(async () => {
    riskEngine.recordRpcSuccess();
    riskEngine.setCircuitBreaker('CLOSED');
    riskEngine.setKillSwitch(false);
    await new Promise<void>((r) => httpServer.close(() => r()));
  });
  /** The kill-switch journal rows the reset writes (G journals each change; the next boot reads the latest one). */
  const resetJournal = () => vi.spyOn(workstationDb, 'logJournal');
  const reset = async () => {
    const res = await fetch(`${base}/api/execution/kill-switch`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ activate: false }),
    });
    return { status: res.status, json: await res.json() };
  };
  /** Make the coordinator's next balance reads fail or succeed, then run them as the wallet loop does. */
  const balanceReads = async (ok: boolean, n: number) => {
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    const conn = executionCoordinator.getConnection();
    vi.spyOn(conn, 'getBalance').mockImplementation(async () => { if (!ok) throw new Error('fetch failed'); return 2_000_000_000; });
    for (let i = 0; i < n; i++) await executionCoordinator.syncRealWalletBalance();
    vi.restoreAllMocks();
  };

  it('after three failed reads the reset leaves the breaker OPEN and says why; System checks says the same', async () => {
    await balanceReads(false, 3);
    expect(riskEngine.getCircuitBreakerState()).toBe('OPEN');
    expect(riskEngine.isKillSwitchActive()).toBe(true);
    // The automatic trip journals why, so G's KILL_SWITCH_WAS_ON boot alert no longer says "no reason given".
    expect(workstationDb.getKillSwitchTripBeforeRestart()).toBe('circuit breaker: 3 wallet balance reads failed in a row');
    const journal = resetJournal();
    const r = await reset();
    expect(journal).toHaveBeenCalledWith('KILL_SWITCH_RESET', 'kill-switch', 'PAPER', { reason: expect.stringMatching(/^operator reset; circuit breaker still open: the latest wallet balance read failed/) });
    expect(r.status).toBe(200);
    expect(r.json.killSwitchActive).toBe(false);
    expect(r.json.circuitBreaker).toBe('OPEN');
    expect(r.json.circuitBreakerReset.closed).toBe(false);
    expect(r.json.circuitBreakerReset.reason).toMatch(/latest wallet balance read failed \(3 in a row\)/);
    const row = buildSystemChecks().checks.find((c) => c.id === 'killswitch')!;
    expect(row.status).toBe('FAIL');
    expect(row.detail).toMatch(/stays open until a read succeeds/);
  });

  it('once a read succeeds, System checks says a reset will close it, and the reset closes it', async () => {
    await balanceReads(true, 1);
    expect(riskEngine.getCircuitBreakerState()).toBe('OPEN'); // a good read alone does not close it
    expect(buildSystemChecks().checks.find((c) => c.id === 'killswitch')!.detail).toMatch(/resetting the kill switch closes it/);
    riskEngine.setKillSwitch(true, 'f2 test'); // tripped again so the reset writes a row
    const journal = resetJournal();
    const r = await reset();
    expect(journal).toHaveBeenCalledWith('KILL_SWITCH_RESET', 'kill-switch', 'PAPER', { reason: 'operator reset; circuit breaker closed' });
    expect(r.json.circuitBreaker).toBe('CLOSED');
    expect(r.json.circuitBreakerReset.closed).toBe(true);
    expect(riskEngine.getCircuitBreakerState()).toBe('CLOSED');
    expect(buildSystemChecks().checks.find((c) => c.id === 'killswitch')!.status).toBe('OK');
  });
});
