import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, executionCoordinator, ACKNOWLEDGEABLE_ALERT_CODES } from '../server/execution/coordinator';
import { buildSystemChecks } from '../server/system/systemChecks';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { AlertSystem } from '../src/components/AlertSystem';
import { readServerAlerts, serverAlertEvents, acknowledgeServerAlert } from '../src/utils/operatorAlerts';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';
import { startApp, scratchDir, type AppHandle } from './helpers/liveServer';

/**
 * CRITICAL operator alerts that report a past event (POSITION_GONE, POSITION_BALANCE_MISSING, SELL_ADOPTED, LEDGER_WRITE_FAILED) cleared
 * only on a restart, and a POSITION_MARK_UNAVAILABLE stayed after its position closed. Real coordinator and SQLite (RPC, builder and
 * reconciler stubbed at their edges, as tests/r6_9_close_outcome.test.ts), the real system checks and alert stack, and the real server
 * for the route. Throwaway keys.
 */
const uid = () => Math.random().toString(36).slice(2);
const wire = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

describe('acknowledging an alert that reports a past event; a closed position leaves no mark alert', () => {
  let coordinator: ExecutionCoordinator;
  let posId: string;

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    const kp = Keypair.generate();
    const rpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(rpc.createConnection());
    await initDone;
    (coordinator as any).connection.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 1000, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({ success: true, signature: 'ackSell', transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' });
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    posId = `ack_${uid()}`;
    workstationDb.savePosition({
      id: posId, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'ACK', name: 'ack', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001,
      currentPriceSol: 0.00005, currentValueSol: 0.05, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', walletPubkey: kp.publicKey.toBase58(), entryTxSignature: `sig_${posId}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
  });

  it('an empty-wallet close raises POSITION_BALANCE_MISSING and clears the position\'s mark alert; the operator acknowledges the first, by code and position', async () => {
    (coordinator as any).raiseOperatorAlert('POSITION_MARK_UNAVAILABLE', 'No price for ACK', posId);
    (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '0' } }));
    const res = await coordinator.closePosition(posId, 100, 'Manual user order');
    expect(res).toMatchObject({ success: true, status: 'CLOSED' });
    const codes = () => coordinator.getOperatorAlerts().filter((a) => a.positionId === posId).map((a) => a.code);
    expect(codes()).toEqual(['POSITION_BALANCE_MISSING']);

    // nothing else clears it: a later exit pass leaves it, and only the right code and position acknowledge it
    await (coordinator as any).runExitPass();
    expect(codes()).toEqual(['POSITION_BALANCE_MISSING']);
    expect(coordinator.acknowledgeOperatorAlert('POSITION_BALANCE_MISSING', 'some-other-position')).toMatchObject({ acknowledged: false, error: expect.stringMatching(/^NOT_FOUND/) });
    expect(coordinator.acknowledgeOperatorAlert('POSITION_BALANCE_MISSING', posId)).toEqual({ acknowledged: true });
    expect(codes()).toEqual([]);
    expect(coordinator.acknowledgeOperatorAlert('POSITION_BALANCE_MISSING', posId).error).toMatch(/^NOT_FOUND/);
  });

  it('an alert whose condition still holds cannot be acknowledged away', () => {
    (coordinator as any).raiseOperatorAlert('EXIT_FAILING', 'Exit for ACK failed 3 times', posId);
    const r = coordinator.acknowledgeOperatorAlert('EXIT_FAILING', posId);
    expect(r.acknowledged).toBe(false);
    expect(r.error).toMatch(/^NOT_ACKNOWLEDGEABLE: EXIT_FAILING/);
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_FAILING' && a.positionId === posId)).toBe(true);
  });

  it('the exit pass clears a POSITION_MARK_UNAVAILABLE whose position closed by another path', async () => {
    (coordinator as any).raiseOperatorAlert('POSITION_MARK_UNAVAILABLE', 'No price for ACK', posId);
    const row = workstationDb.loadPositions().find((p) => p.id === posId)!;
    workstationDb.savePosition({ ...row, status: 'CLOSED', tokenQuantityRaw: '0' });
    await (coordinator as any).runExitPass();
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'POSITION_MARK_UNAVAILABLE' && a.positionId === posId)).toBe(false);
  });
});

describe('the alert stack offers Acknowledge for exactly those alerts', () => {
  const coord = executionCoordinator as any;
  afterEach(() => { for (const c of ['POSITION_GONE', 'EXIT_NO_SIGNER', 'SELL_ADOPTED']) coord.clearOperatorAlert(c, 'pos-ack-ui'); });

  it('/api/system/checks marks them acknowledgeable; the stack shows the button for them only, and hides one the server confirmed', () => {
    expect([...ACKNOWLEDGEABLE_ALERT_CODES].sort()).toEqual(['BUY_OUTCOME_UNKNOWN', 'LEDGER_WRITE_FAILED', 'POSITION_BALANCE_MISSING', 'POSITION_GONE', 'SELL_ADOPTED', 'TOKENS_LEFT_AFTER_EXIT']);
    coord.raiseOperatorAlert('POSITION_GONE', 'XYZ was recorded open but the wallet holds none of it', 'pos-ack-ui');
    coord.raiseOperatorAlert('EXIT_NO_SIGNER', 'Exit cannot be signed', 'pos-ack-ui');
    const alerts = readServerAlerts(wire(buildSystemChecks())).filter((a) => a.positionId === 'pos-ack-ui');
    expect(alerts.find((a) => a.code === 'POSITION_GONE')!.acknowledgeable).toBe(true);
    expect(alerts.find((a) => a.code === 'EXIT_NO_SIGNER')!.acknowledgeable).toBe(false);
    const events = serverAlertEvents(alerts);
    expect(events.find((e) => e.title === 'POSITION_GONE')!.serverAck).toEqual({ code: 'POSITION_GONE', positionId: 'pos-ack-ui' });
    expect(events.find((e) => e.title === 'EXIT_NO_SIGNER')!.serverAck).toBeUndefined();
    const gone = events.find((e) => e.title === 'POSITION_GONE')!;
    const html = renderToStaticMarkup(<AlertSystem alerts={[gone]} onDismissAlert={() => {}} onClearAll={() => {}} onAcknowledgeAlert={() => {}} />);
    expect(html).toContain('data-testid="alert-acknowledge"');
    expect(html).not.toContain('aria-label="Dismiss alert"'); // still CRITICAL: no browser-only dismiss
    const noSigner = events.find((e) => e.title === 'EXIT_NO_SIGNER')!;
    const html2 = renderToStaticMarkup(<AlertSystem alerts={[noSigner]} onDismissAlert={() => {}} onClearAll={() => {}} onAcknowledgeAlert={() => {}} />);
    expect(html2).not.toContain('data-testid="alert-acknowledge"');
    expect(html2).toContain('data-testid="alert-sticky"');
    expect(serverAlertEvents(alerts, new Set(), new Set([gone.id])).map((e) => e.title)).toEqual(['EXIT_NO_SIGNER']);
  });
});

describe('POST /api/system/alerts/acknowledge on the real server', () => {
  let app: AppHandle;
  beforeAll(async () => {
    app = await startApp(scratchDir('alert-ack-'), {});
    return () => app.stop();
  }, 120_000);

  it('needs the operator token, a code, an acknowledgeable code and an open alert; the UI helper reports the reason', async () => {
    const anon = await fetch(`${app.base}/api/system/alerts/acknowledge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'POSITION_GONE', positionId: 'p' }) });
    expect(anon.status).toBe(401);
    expect((await app.call('POST', '/api/system/alerts/acknowledge', {})).status).toBe(400);
    const halted = await app.call('POST', '/api/system/alerts/acknowledge', { code: 'TRADING_HALTED' });
    expect(halted.status).toBe(409);
    expect(halted.json.error).toMatch(/^NOT_ACKNOWLEDGEABLE/);
    const none = await app.call('POST', '/api/system/alerts/acknowledge', { code: 'POSITION_GONE', positionId: 'no-such-position' });
    expect(none.status).toBe(404);
    expect(none.json.error).toMatch(/^NOT_FOUND: no open POSITION_GONE alert for no-such-position/);
    // the UI helper posts the same body with the operator token and reports the server's reason
    const post = (path: string, init: RequestInit) => fetch(app.base + path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${app.token}` } });
    expect(await acknowledgeServerAlert(post, { code: 'POSITION_GONE', positionId: 'no-such-position' })).toMatch(/^NOT_FOUND: .* \(HTTP 404\)$/);
  });
});
