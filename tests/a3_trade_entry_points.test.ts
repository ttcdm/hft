import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { AddressInfo } from 'net';
import {
  ArmSchema,
  CalloutSnipeSchema,
  OPERATOR_PROVENANCE,
  OperatorCloseSchema,
  OperatorExecuteTradeSchema,
  OperatorSnipeSchema,
  SignalSnipeSchema,
  SniperConfigPatchSchema,
  ToggleCallerSchema,
  validateTradeBody,
  validateTradeInput,
} from '../server/execution/tradeInputs';
import { walletTrader } from '../server/walletTrader';
import { executionCoordinator } from '../server/execution/coordinator';

const MINT = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBA52';

afterEach(() => {
  vi.restoreAllMocks();
});

async function post(schema: Parameters<typeof validateTradeBody>[0], body: unknown) {
  const app = express();
  app.use(express.json());
  let seen: unknown = null;
  app.post('/t', validateTradeBody(schema), (req, res) => {
    seen = req.body;
    res.json({ ok: true });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/t`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json(), seen };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('A3: trade entry point validation', () => {
  describe('server-set provenance', () => {
    it('operator provenance is MANUAL_OPERATOR', () => {
      expect(OPERATOR_PROVENANCE).toBe('MANUAL_OPERATOR');
    });

    it.each(['provenance', 'enforceConfluence', 'minConfluenceScore', 'eligibilityReport', 'executionMode', 'signalTimestamp', 'marketDataTimestamp', 'source'])(
      'a snipe request that sets %s is rejected with 400',
      async (key) => {
        const res = await post(OperatorSnipeSchema, { contractAddress: MINT, amountUsd: 5, [key]: key === 'enforceConfluence' ? false : 'REAL_ONCHAIN' });
        expect(res.status).toBe(400);
        expect(res.json.issues.map((i: any) => i.path)).toContain(key);
      }
    );

    it('execution/trade no longer accepts client provenance', async () => {
      const res = await post(OperatorExecuteTradeSchema, { mint: MINT, symbol: 'X', name: 'X', amountSol: 0.01, provenance: 'MANUAL_OPERATOR' });
      expect(res.status).toBe(400);
    });

    it('walletTrader.executeLiveSnipe sends MANUAL_OPERATOR provenance to the coordinator', async () => {
      const exec = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: false, lifecycleState: 'RISK_REJECTED', executionMode: 'PAPER', error: 'stub', correlationId: 'c' });
      await walletTrader.executeLiveSnipe({ mint: MINT, amountSol: 0.01 });
      expect(exec).toHaveBeenCalledWith(expect.objectContaining({ provenance: 'MANUAL_OPERATOR', source: 'MANUAL' }));
    });
  });

  describe('input bounds', () => {
    const bad: Array<[string, unknown]> = [
      ['missing address', { amountUsd: 5 }],
      ['short address', { contractAddress: 'abc', amountUsd: 5 }],
      ['address with invalid base58 chars', { contractAddress: '0'.repeat(40) }],
      ['negative amount', { contractAddress: MINT, amountUsd: -1 }],
      ['zero amount', { contractAddress: MINT, amountUsd: 0 }],
      ['NaN amount', { contractAddress: MINT, amountUsd: 'abc' }],
      ['huge amount', { contractAddress: MINT, amountUsd: 1e9 }],
      ['tip above cap', { contractAddress: MINT, jitoTipSol: 5 }],
      ['slippage above 50', { contractAddress: MINT, slippagePct: 99 }],
    ];
    it.each(bad)('snipe rejects %s', async (_name, body) => {
      const res = await post(OperatorSnipeSchema, body);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('INVALID_REQUEST');
    });

    it('snipe applies defaults (no tip default: absent means dynamic policy), coerces numeric strings and drops unknown keys', async () => {
      const res = await post(OperatorSnipeSchema, { contractAddress: ` ${MINT} `, amountUsd: '7.5', extra: 'x', action: 'SNIPE_MEMECOIN', sessionToken: 't' });
      expect(res.status).toBe(200);
      expect(res.seen).toEqual({ contractAddress: MINT, amountUsd: 7.5, platform: undefined, jitoTipSol: undefined, slippagePct: 8, signalId: undefined });
    });

    it('close requires a position id, bounds sellPct and defaults to 100', async () => {
      expect((await post(OperatorCloseSchema, {})).status).toBe(400);
      expect((await post(OperatorCloseSchema, { positionId: 'p', sellPct: 0 })).status).toBe(400);
      expect((await post(OperatorCloseSchema, { positionId: 'p', sellPct: 101 })).status).toBe(400);
      const ok = await post(OperatorCloseSchema, { positionId: 'p' });
      expect(ok.status).toBe(200);
      expect(ok.seen).toMatchObject({ positionId: 'p', sellPct: 100 });
    });

    it('callout, signal, caller toggle and arm schemas validate their ids', async () => {
      expect((await post(CalloutSnipeSchema, {})).status).toBe(400);
      expect((await post(CalloutSnipeSchema, { calloutId: 'c1' })).status).toBe(200);
      expect((await post(SignalSnipeSchema, { amountUsd: 5 })).status).toBe(400);
      expect((await post(ToggleCallerSchema, { userId: '' })).status).toBe(400);
      expect((await post(ArmSchema, { confirmationCode: 'x'.repeat(65) })).status).toBe(400);
      expect((await post(ArmSchema, { arm: true, confirmationCode: 'ok' })).status).toBe(200);
    });

    it('execute trade accepts a good request and strips unknown keys', async () => {
      const res = await post(OperatorExecuteTradeSchema, { mint: MINT, symbol: 'AB', name: 'Alpha Beta', amountSol: '0.01', slippageBps: 300, rogue: 1 });
      expect(res.status).toBe(200);
      expect(res.seen).toMatchObject({ mint: MINT, symbol: 'AB', amountSol: 0.01, slippageBps: 300 });
      expect(res.seen).not.toHaveProperty('rogue');
    });

    it('sniper config patch keeps only known fields and rejects bad values', async () => {
      const ok = await post(SniperConfigPatchSchema, { isAutoSnipeEnabled: true, maxSlippagePct: '10', polluted: 'x', __proto__x: 1 });
      expect(ok.status).toBe(200);
      expect(ok.seen).toEqual({ isAutoSnipeEnabled: true, maxSlippagePct: 10 });
      expect((await post(SniperConfigPatchSchema, { maxSlippagePct: 500 })).status).toBe(400);
      expect((await post(SniperConfigPatchSchema, { isAutoSnipeEnabled: 'yes' })).status).toBe(400);
    });

    it('validateTradeInput reports issue paths for WebSocket callers', () => {
      const res = validateTradeInput(OperatorCloseSchema, { sellPct: 5 });
      expect(res.status).toBe('invalid');
      if (res.status === 'invalid') expect(res.issues[0].path).toBe('positionId');
    });
  });

  describe('every client-reachable trade entry point is covered (static walk of server.ts)', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
    const blocks = source.split(/^(?=app\.(?:get|post|put|delete|patch)\()/m).filter((b) => b.startsWith('app.'));
    const TRADE_CALLS = /executeSnipe|closePosition|executeTrade|snipeCallout|armLiveTrading|panicLiquidateAll|toggleCallerAutoSnipe|memecoinAggregator\.updateConfig|walletTrader\.executeLiveSnipe/;

    it('every HTTP route that reaches a trade, close, arm or config call validates its body', () => {
      const trading = blocks.filter((b) => TRADE_CALLS.test(b));
      expect(trading.length).toBeGreaterThanOrEqual(12);
      const unvalidated = trading
        .filter((b) => !/validateTradeBody\(|validateBody\(/.test(b.split('\n')[0]))
        // Routes with no client-chosen parameters at all.
        .filter((b) => !/^app\.post\('\/api\/(wallet\/panic-liquidate|execution\/kill-switch)'/.test(b))
        .map((b) => b.split('\n')[0]);
      expect(unvalidated).toEqual([]);
    });

    it('every trading route requires operator auth', () => {
      const trading = blocks.filter((b) => TRADE_CALLS.test(b) && b.startsWith('app.post'));
      const open = trading.filter((b) => !b.split('\n')[0].includes('requireOperatorAuth')).map((b) => b.split('\n')[0]);
      expect(open).toEqual([]);
    });

    it('no route reads provenance from the request', () => {
      expect(source).not.toMatch(/req\.body\.provenance|req\.body\?\.provenance|parsed\.provenance/);
    });

    it.each(['SNIPE_PUMP_CALLOUT', 'TOGGLE_CALLER_SNIPE', 'SNIPE_MEMECOIN', 'CLOSE_POSITION'])('WebSocket action %s validates its input', (action) => {
      const start = source.indexOf(`parsed.action === '${action}'`);
      expect(start).toBeGreaterThan(-1);
      const snippet = source.slice(start, start + 400);
      expect(snippet).toContain('validateTradeInput(');
    });

    it('WebSocket PANIC_LIQUIDATE is in the authenticated mutating set', () => {
      const setStart = source.indexOf('MUTATING_WS_ACTIONS = new Set');
      expect(source.slice(setStart, setStart + 600)).toContain("'PANIC_LIQUIDATE'");
    });
  });
});
