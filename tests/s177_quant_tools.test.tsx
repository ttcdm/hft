import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSystemChecks } from '../server/system/systemChecks';
import { computeLatency, percentile } from '../server/system/latencyStats';
import { buildDiagnosticsContext } from '../server/system/aiContext';
import { executionCoordinator } from '../server/execution/coordinator';
import { autoSnipeController } from '../server/auto/controller';
import { watchWindow } from '../server/signals/watchWindow';
import { workstationDb, type PersistedTransaction } from '../server/db/database';
import { SystemChecksView } from '../src/components/SystemChecksModal';
import { ExecutionLatencyView } from '../src/components/ExecutionLatencyModal';
import { AutoPipelineView } from '../src/components/AutoPipelineModal';
import { AiDiagnosticsModal } from '../src/components/AiDiagnosticsModal';
import { checksBadgeFor } from '../src/components/Header';

afterEach(() => { vi.restoreAllMocks(); executionCoordinator.clearHalt(); });

// the JSON a client gets over HTTP is the server object after JSON.stringify; render from that, not from the in-memory object
const wire = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

describe('S177: System checks render the server\'s live answer', () => {
  it('every check the brief names is present, with a status and a measured value, rendered from the wire JSON', () => {
    const data = wire(buildSystemChecks());
    const html = renderToStaticMarkup(<SystemChecksView data={data} />);
    for (const id of ['cluster', 'signer', 'rpc', 'reconciliation', 'halt', 'killswitch', 'feed', 'capacity', 'marks', 'database']) {
      expect(html, id).toContain(`data-testid="check-${id}"`);
    }
    expect(html).toContain(`cluster <strong class="text-slate-200">${data.cluster}</strong>`);
    for (const c of data.checks) expect(['OK', 'WARN', 'FAIL', 'UNKNOWN']).toContain(c.status);
    // a hermetic test run has no RPC: the cluster check must not claim to be verified
    expect(data.checks.find((c) => c.id === 'cluster')!.status).not.toBe('OK');
  });

  it('a halt shows as FAIL with its reason; clearing it shows OK again', () => {
    executionCoordinator.haltAll('test halt: wallet changed by an unexplained 0.5 SOL');
    const halted = wire(buildSystemChecks()).checks.find((c) => c.id === 'halt')!;
    expect(halted.status).toBe('FAIL');
    expect(halted.detail).toContain('unexplained 0.5 SOL');
    expect(renderToStaticMarkup(<SystemChecksView data={wire(buildSystemChecks())} />)).toContain('ALL TRADING HALTED');
    executionCoordinator.clearHalt();
    expect(buildSystemChecks().checks.find((c) => c.id === 'halt')!.status).toBe('OK');
  });

  it('a stale-mark alert shows on the marks row, with the aggregate alert\'s own message', () => {
    (executionCoordinator as any).raiseOperatorAlert('PAPER_MARKS_UNAVAILABLE', '7 more PAPER position(s) have no price (oldest 90s)');
    const marks = buildSystemChecks().checks.find((c) => c.id === 'marks')!;
    expect(marks.status).toBe('WARN');
    expect(marks.value).toMatch(/1 stale-mark alert/);
    expect(marks.detail).toContain('7 more PAPER position');
    (executionCoordinator as any).clearOperatorAlert('PAPER_MARKS_UNAVAILABLE', undefined);
  });

  it('an unreadable result renders its error and no checks', () => {
    const html = renderToStaticMarkup(<SystemChecksView data={null} error="Request refused (HTTP 401)" />);
    expect(html).toContain('Request refused (HTTP 401)');
    expect(html).not.toContain('data-testid="check-');
  });

  it('the header badge is a count: all OK, or how many are not', () => {
    expect(checksBadgeFor(null).text).toBe('no data');
    expect(checksBadgeFor([{ status: 'OK' }, { status: 'OK' }]).text).toBe('2/2 OK');
    expect(checksBadgeFor([{ status: 'OK' }, { status: 'FAIL' }, { status: 'UNKNOWN' }]).text).toBe('2 not OK');
  });
});

describe('S177: Execution latency is measured from the journal', () => {
  const tx = (over: Partial<PersistedTransaction>): PersistedTransaction => ({
    signature: Keypair.generate().publicKey.toBase58(), orderId: 'o', correlationId: 'c', mint: 'M1', direction: 'BUY', submissionTransport: 'SOLANA_RPC',
    submissionTime: 1_000, confirmationTime: 1_900, reconciliationState: 'RECONCILED', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE', ...over,
  });

  it('percentiles and signal-to-send are computed from rows, a pending transaction is excluded and counted, PAPER is a row of its own', () => {
    const txs = [
      tx({ mint: 'M1', submissionTime: 10_000, confirmationTime: 10_800 }),
      tx({ mint: 'M2', submissionTime: 20_000, confirmationTime: 21_200 }),
      tx({ mint: 'M3', submissionTime: 30_000, confirmationTime: 30_400 }),
      tx({ mint: 'M4', submissionTime: 40_000, confirmationTime: undefined, reconciliationState: 'PENDING' }),
      tx({ mint: 'M5', submissionTransport: 'PAPER', executionMode: 'PAPER', submissionTime: 50_000, confirmationTime: 50_001 }),
    ];
    const r = computeLatency(txs, [{ ts: 9_500, mint: 'M1' }, { ts: 9_900, mint: 'M1' }, { ts: 19_000, mint: 'M2' }, { ts: 1, mint: 'NEVER_BOUGHT' }]);
    const real = r.sendToConfirm.find((x) => x.label === 'SOLANA_RPC / LIVE / BUY')!;
    expect(real).toMatchObject({ n: 3, p50Ms: 800, maxMs: 1200 });
    expect(r.sendToConfirm.find((x) => x.label.startsWith('PAPER'))!.n).toBe(1);
    expect(r.counts).toMatchObject({ transactions: 5, confirmed: 4, unconfirmed: 1 });
    const sig = r.signalToSend.find((x) => x.label === 'SOLANA_RPC / LIVE')!;
    expect(sig.n).toBe(2);                 // M1 counted once (first QUEUED row), M2 once, the never-bought mint not at all
    expect(sig.p50Ms).toBe(500);           // M1: 10000-9500 = 500, M2: 20000-19000 = 1000 -> p50 = 500
    expect(r.notes.join(' ')).toMatch(/PAPER rows never touched the network/);
    expect(percentile([], 50)).toBeNull();
  });

  it('with no rows every figure is empty and the screen says there is nothing to measure', () => {
    const html = renderToStaticMarkup(<ExecutionLatencyView data={wire(computeLatency([], []))} />);
    expect(html).toContain('No confirmed transaction yet: nothing to measure.');
    expect(html).toContain('No candidate has been followed by a buy yet: nothing to measure.');
    expect(html).toContain('0 transaction(s) in the journal');
  });

  it('rendered from the real journal after a PAPER trade: the paper transaction has no confirmation time, so it is counted and left out of the figures', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const res = await executionCoordinator.executeTrade({ mint, symbol: 'LAT', name: 'LAT', amountSol: 0.005, jitoTipSol: 0.0001, source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', currentPriceSol: 0.0001 });
    expect(res.success, res.error).toBe(true);
    const rep = computeLatency(workstationDb.loadTransactions(), workstationDb.loadDecisions({ stage: 'queue', outcome: 'QUEUED', limit: 100 }).map((d) => ({ ts: d.ts, mint: d.mint })));
    expect(rep.counts.transactions).toBeGreaterThan(0);
    const html = renderToStaticMarkup(<ExecutionLatencyView data={wire(rep)} />);
    expect(html).toContain('data-testid="latency-confirm"');
    expect(html).toMatch(/\d+ transaction\(s\) in the journal/);
    expect(html).toMatch(/without a confirmation time/);
    expect(html).toContain('nothing to measure');
  });
});

describe('S177: Auto pipeline shows the real controller and watch window', () => {
  it('mode, counts, rejections by stage and watch capacity are rendered from /api/auto/status and /api/watch shaped output', () => {
    workstationDb.logDecision({ autoMode: 'SHADOW', mint: 'MINT_A', stage: 'queue', outcome: 'QUEUED', reason: 'candidate received' });
    workstationDb.logDecision({ autoMode: 'SHADOW', mint: 'MINT_A', stage: 'watch', outcome: 'DROPPED', reason: 'WATCH_DEAD: NO_TRADES' });
    workstationDb.logDecision({ autoMode: 'SHADOW', mint: 'MINT_B', stage: 'queue', outcome: 'QUEUED', reason: 'candidate received' });
    workstationDb.logDecision({ autoMode: 'SHADOW', mint: 'MINT_B', stage: 'eligibility', outcome: 'REJECTED', reason: 'liquidity' });
    const auto = wire({ success: true, ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats() }) as any;
    const watch = wire({ success: true, ...watchWindow.getSnapshot() }) as any;
    const html = renderToStaticMarkup(<AutoPipelineView auto={auto} watch={watch} />);
    expect(html).toContain(`Auto mode <strong>${auto.mode}</strong>`);
    expect(auto.stats.seen).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/watch \d+|watching \d+ of \d+/);
    expect(html).toMatch(/data-testid="pipeline-stages"[^>]*>[^<]*watch \d+/);
    expect(html).toMatch(/eligibility \d+/);
    expect(html).toContain(`of ${watch.capacity.max}`);
  });

  it('with the server env off it says so; the HFT console is offered only as a clearly named secondary link', () => {
    const auto = wire({ ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats() }) as any;
    const html = renderToStaticMarkup(<AutoPipelineView auto={{ ...auto, envEnabled: false }} watch={null} onOpenHftConsole={() => undefined} />);
    expect(html).toContain('AUTO_SNIPE_ENABLED is not true');
    expect(html).toMatch(/HFT simulator console \(BTC\/ETH, in memory, separate from the Solana wallet\)/);
  });
});

describe('S177: Quant AI Diagnostics reads real state and says so', () => {
  it('the server-built context holds the checks, auto journal stats and latency, and no secret or full wallet address', () => {
    const ctx = wire(buildDiagnosticsContext());
    expect(ctx.systemChecks.map((c: any) => c.check)).toContain('Signer');
    expect(ctx.journal).toHaveProperty('rejectedByStage');
    expect(ctx.latency).toHaveProperty('sendToConfirm');
    const text = JSON.stringify(ctx);
    expect(text).not.toMatch(/privateKey|secretKey|sessionToken|OPERATOR_/i);
    expect(text).not.toContain(executionCoordinator.getDiagnostics().activeWalletAddress.length > 20 ? executionCoordinator.getDiagnostics().activeWalletAddress : 'NO_WALLET_TO_MATCH_XYZ');
  });

  it('the modal states what it reads, what it sends and that it needs a key; the route takes no client-supplied figures', () => {
    const html = renderToStaticMarkup(<AiDiagnosticsModal isOpen={true} onClose={() => undefined} />);
    expect(html).toMatch(/Reads the server(&#x27;|')s live state/);
    expect(html).toMatch(/GEMINI_API_KEY/);
    expect(html).not.toMatch(/gamma|jitter|market making/i);
    const src = fs.readFileSync('server.ts', 'utf8');
    const route = src.slice(src.indexOf("'/api/ai/diagnostics'"), src.indexOf("'/api/export/packets'"));
    expect(route).toContain('buildDiagnosticsContext()');
    expect(route).not.toMatch(/strategyConfig|telemetry/);
  });
});

describe('S177: routes and removals', () => {
  it('the live-state routes exist and the toy routes are gone', () => {
    const src = fs.readFileSync('server.ts', 'utf8');
    expect(src).toContain("'/api/system/checks'");
    expect(src).toContain("'/api/system/latency'");
    expect(src).not.toContain("'/api/unit-tests'");
    for (const f of ['src/components/UnitTestModal.tsx', 'src/components/MicrostructureRealismModal.tsx', 'server/unitTestCases.ts']) expect(fs.existsSync(f), f).toBe(false);
  });
});
