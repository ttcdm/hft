import './server/loadEnv'; // must stay the FIRST import: singletons built at import time read process.env
import './server/instanceLockBoot'; // P1.1: must stay the SECOND import: a second server on the same database exits here, before any singleton exists
import { tracingReady } from './server/observability/init'; // S209: starts OpenTelemetry tracing when APEX_TRACING=true; does nothing otherwise
import './suppress-warnings.cjs';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'node:fs';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer, createLogger } from 'vite';
import { secretPathGuard, viteDevServerOptions } from './server/security/secretPaths';
import { GoogleGenAI } from '@google/genai';
import { socialScanner, isTelegramTradeCommand, xTwitterScopeEntry } from './server/socialScanner';
import { memecoinAggregator } from './server/memecoinAggregator';
import { onChainPoolStats } from './server/market/poolStats';
import { wireWatchPins, wireCreatorReportPins } from './server/signals/watchPins';
import { creatorRiskScorer } from './server/signals/creatorRiskScorer';
import { buildSystemChecks } from './server/system/systemChecks';
import { isReadOnly, assertReadOnlyStartup } from './server/solana/readOnly';
import { LaunchRecorder } from './server/backtest/launchRecorder';
import { recorderConfig, recorderConfigProblems, replayCacheKey } from './server/backtest/recorderConfig';
import { replayLaunchesAsync } from './server/backtest/replay';
import { checkConfluenceThreshold, getConfluenceThreshold, envConfluenceProblem } from './server/signals/confluenceThreshold';
import { maxCurveProgressProblem } from './server/signals/curveProgressCap';
import { curveVelocityEvaluator } from './server/signals/curveVelocityEvaluator';
import { computeLatency } from './server/system/latencyStats';
import { buildDiagnosticsContext } from './server/system/aiContext';
import { pumpFunService, pumpBootMode } from './server/pumpfunService';
import { pumpFeedListener } from './server/solana/pumpFeedListener';
import { autoSnipeController } from './server/auto/controller';
import { watchWindow } from './server/signals/watchWindow';
import { FunderLookup, wireFunderLookup } from './server/signals/funderLookup';
import { buildBoard } from './server/board';
import { PublicKey } from '@solana/web3.js';
import { solPriceService } from './server/market/solPriceService';
import { checkSnipeAmountSol, getSnipeLimits } from './server/execution/snipeAmount';
import { PumpCurveService } from './server/solana/pumpCurve';
import { buildCurveDepth } from './server/market/curveDepth';
import { TradeTape } from './server/market/tradeTape';
import { exitRulesSummary } from './server/exits/exitEngine';
import { walletTrader } from './server/walletTrader';
import { emergencyStop } from './server/execution/emergencyStop';
import { asyncHandler } from './server/middleware/asyncHandler';
import { resolveRpcUrl, allowedCluster } from './server/solana/clusterGuard';
import { liveConfirmationRefusal } from './server/execution/liveConfirmation';
import {
  ArmSchema,
  AutoModeSchema,
  AutoBudgetSchema,
  AutoOrderSizeSchema,
  AutoThresholdSchema,
  AutoKillSchema,
  AutoResumeSchema,
  CalloutSnipeSchema,
  AutoSnipeRulesSchema,
  OPERATOR_PROVENANCE,
  OperatorCloseSchema,
  OperatorExecuteTradeSchema,
  OperatorSnipeSchema,
  SignalSnipeSchema,
  KillSwitchSchema,
  SniperConfigPatchSchema,
  validateTradeBody,
  validateTradeInput,
} from './server/execution/tradeInputs';
import { executionCoordinator } from './server/execution/coordinator';
import { localSigner } from './server/solana/signer';
import { riskEngine } from './server/risk/riskEngine';
import { workstationDb } from './server/db/database';
import {
  authManager,
  requireOperatorAuth,
  apiAuthGate,
  resolveBindHost,
  isAllowedClientOrigin,
  isAllowedWsConnection,
  verifyWsAuth,
} from './server/middleware/auth';
import {
  findLoosePermissions,
  defaultSecretFilePaths,
  loosePermissionWarnings,
} from './server/middleware/filePermissions';
export { isAllowedClientOrigin };
import {
  Logger,
  endpointOrigin,
  correlationIdMiddleware,
  errorHandler,
  rateLimiter,
  LOGIN_RATE_LIMIT,
  securityHeadersMiddleware,
  validateBody,
  WalletConfigSchema,
  LiveSnipeOrderSchema,
  ClosePositionSchema, publicHealthBody } from './server/middleware/enterprise';


const app = express();
// Defense in depth with the normalized auth gate: `/API/...` must not reach a route at all.
app.set('case sensitive routing', true);
// P1.1: the trading side (reconciliation, the exit loop, the restored auto mode) starts only after `listen` succeeds. A request that
// arrives in the few milliseconds between the two waits for it, so nobody reads the auto mode before it is restored.
let markBootDone: () => void = () => undefined;
const bootDone = new Promise<void>((resolve) => { markBootDone = resolve; });
let booted = false;
void bootDone.then(() => { booted = true; });
app.use((_req, _res, next) => { if (booted) next(); else void bootDone.then(() => next()); });
// Nginx/Cloud Run listens on 8080 in container; internal Node/Vite applet must listen on port 3000
const PORT = parseInt(
  process.env.APP_PORT || (process.env.PORT && process.env.PORT !== '8080' ? process.env.PORT : '3000'),
  10
);
const bindResolution = resolveBindHost();
const BIND_HOST = bindResolution.host;
if (bindResolution.warning) {
  Logger.warn(bindResolution.warning);
}
for (const warning of loosePermissionWarnings(findLoosePermissions(defaultSecretFilePaths()))) {
  Logger.warn(warning);
}
const server = http.createServer(app);
// P1.1 (N-51): a port already in use, or any other listen error, ends this process. Without this, `ws` turned EADDRINUSE into a
// warning and a "failed" second boot kept running with no HTTP port.
server.on('error', (err: any) => {
  Logger.error(`[PROCESS] HTTP server error, exiting: ${err?.code || ''} ${err?.message || err}`);
  process.exit(1);
});

// WebSocket Server for High-Performance Engine Telemetry & Orders
const wss = new WebSocketServer({ server, path: '/ws/engine' });

wss.on('error', (err: any) => {
  Logger.warn(`WebSocketServer error: ${err?.message || err}`);
});

// Safe JSON stringify that serializes BigInt as string
function safeJsonStringify(payload: any): string {
  try {
    return JSON.stringify(payload, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
  } catch (err: any) {
    Logger.error(`safeJsonStringify error: ${err.message}`);
    return String(payload);
  }
}

/** WS close code for a socket whose operator token was rotated, revoked or expired after it authenticated (3G, N-4). */
const WS_CLOSE_TOKEN_REVOKED = 4001;

/**
 * 3G (N-4): an authenticated socket keeps the token it authenticated with, and stays authenticated only while that token validates.
 * It used to keep a flag set once, so a rotate, logout or expiry did not stop the sensitive broadcasts. Returns false (and closes the
 * socket with 4001) when the token no longer validates.
 */
function wsTokenStillValid(client: WebSocket): boolean {
  const c = client as any;
  if (!c.isAuthenticated) return true;
  if (verifyWsAuth(c.operatorToken)) return true;
  c.isAuthenticated = false;
  c.operatorToken = undefined;
  try { client.close(WS_CLOSE_TOKEN_REVOKED, 'Operator token revoked'); } catch {}
  return false;
}

// A rotate or logout closes the sockets it revoked right away, not at the next broadcast.
authManager.onRevoke(() => wss.clients.forEach((client) => { wsTokenStillValid(client); }));

// Helper to broadcast WS messages safely (default sensitiveOnly = true: requires operator auth)
function broadcastWs(payload: any, sensitiveOnly: boolean = true) {
  const str = safeJsonStringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (!wsTokenStillValid(client)) return;
      if (sensitiveOnly && !(client as any).isAuthenticated) {
        return;
      }
      try {
        client.send(str);
      } catch {}
    }
  });
}

wss.on('connection', (ws: WebSocket, req: any) => {
  ws.on('error', (err: any) => {
    Logger.debug(`Client WebSocket error: ${err?.message || err}`);
  });

  ws.on('close', (code: number) => {
    Logger.debug(`Client WebSocket closed with code ${code}`);
  });

  // Origin verification for WebSocket connections (strict matching, no broad wildcards)
  const origin = (req?.headers?.origin || '') as string;
  const host = (req?.headers?.host || '') as string;
  if (!isAllowedWsConnection(origin, host, req?.socket?.remoteAddress)) {
    ws.close(4003, 'Unauthorized WebSocket Origin');
    return;
  }

  // Enforce flow: CONNECT -> AUTH_REQUIRED -> authenticate -> AUTHENTICATED -> private snapshots (R0.11)
  (ws as any).isAuthenticated = false;
  try {
    ws.send(
      JSON.stringify({
        type: 'AUTH_REQUIRED',
        message: 'Operator session authentication required before receiving engine telemetry and market snapshots.',
        timestamp: Date.now(),
      })
    );
  } catch {}

  ws.on('message', async (msg: any) => {
    let parsed: any;
    try {
      parsed = JSON.parse(msg.toString());

      // Operator Authentication command
      if (
        parsed.action === 'AUTHENTICATE' ||
        parsed.action === 'AUTH' ||
        parsed.type === 'AUTH' ||
        parsed.type === 'AUTHENTICATE'
      ) {
        const token = parsed.sessionToken || parsed.token;
        if (verifyWsAuth(token)) {
          (ws as any).isAuthenticated = true;
          (ws as any).operatorToken = token; // 3G: checked again before every broadcast
          ws.send(JSON.stringify({ type: 'AUTHENTICATED', authenticated: true, timestamp: Date.now() }));
          ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', authenticated: true }));
          // Emit telemetry and snapshots exclusively after successful authentication
          ws.send(
            JSON.stringify({
              type: 'PUMP_HOT_CALLOUTS',
              data: {
                callouts: pumpFunService.getHotCallouts(),
                leaderboard: pumpFunService.getLeaderboard(),
                status: pumpFunService.getStatus(),
              },
            })
          );
          ws.send(
            JSON.stringify({
              type: 'MEMECOIN_SNAPSHOT',
              data: {
                pools: memecoinAggregator.getPools(),
                positions: memecoinAggregator.getPositions(),
                config: memecoinAggregator.getConfig(),
              },
            })
          );
          ws.send(JSON.stringify({ type: 'WALLET_STATE_UPDATED', data: walletTrader.getState() }));
          ws.send(
            JSON.stringify({
              type: 'MEMECOIN_POSITIONS_SNAPSHOT',
              data: {
                positions: memecoinAggregator.getPositions(),
              },
            })
          );
        } else {
          ws.send(JSON.stringify({ type: 'AUTH_ERROR', error: 'INVALID_OPERATOR_TOKEN' }));
        }
        return;
      }

      // Mutating WebSocket commands require operator session authorization
      const MUTATING_WS_ACTIONS = new Set([
        'SNIPE_PUMP_CALLOUT',
        'SNIPE_MEMECOIN',
        'CLOSE_POSITION',
        'PANIC_LIQUIDATE',
      ]);

      if (MUTATING_WS_ACTIONS.has(parsed.action)) {
        const token = parsed.sessionToken || parsed.token;
        if (!verifyWsAuth(token)) {
          ws.send(
            JSON.stringify({
              type: 'AUTH_ERROR',
              error: 'UNAUTHORIZED_MUTATION: Valid operator sessionToken is required for execution WebSocket commands',
              action: parsed.action,
            })
          );
          return;
        }
      }

      // Real-time sniper actions via WebSocket routed through authoritative coordinator
      const rejectWsInput = (issues: Array<{ path: string; message: string }>) =>
        ws.send(JSON.stringify({ type: 'VALIDATION_ERROR', action: parsed.action, error: 'INVALID_REQUEST', issues }));

      if (parsed.action === 'SNIPE_PUMP_CALLOUT') {
        const input = validateTradeInput(CalloutSnipeSchema, parsed);
        if (input.status === 'invalid') return rejectWsInput(input.issues);
        const refused = liveGate(parsed); // S1
        if (refused) return void ws.send(JSON.stringify({ type: 'CALLOUT_SNIPE_RESULT', data: { success: false, message: refused } }));
        const result = await pumpFunService.snipeCallout(
          input.data.calloutId,
          input.data.amountUsd,
          input.data.jitoTipSol,
          input.data.slippagePct,
          input.data.amountSol
        );
        ws.send(JSON.stringify({ type: 'CALLOUT_SNIPE_RESULT', data: result }));
      }
      if (parsed.action === 'SNIPE_MEMECOIN') {
        const input = validateTradeInput(OperatorSnipeSchema, parsed);
        if (input.status === 'invalid') return rejectWsInput(input.issues);
        const refused = liveGate(parsed); // S1
        if (refused) return void ws.send(JSON.stringify({ type: 'MEMECOIN_SNIPE_RESULT', data: { success: false, message: refused } }));
        const result = await memecoinAggregator.executeSnipe({ ...withOperatorAmount(input.data), provenance: OPERATOR_PROVENANCE, signalTimestamp: Date.now() });
        ws.send(JSON.stringify({ type: 'MEMECOIN_SNIPE_RESULT', data: result }));
      }
      if (parsed.action === 'CLOSE_POSITION') {
        const input = validateTradeInput(OperatorCloseSchema, parsed);
        if (input.status === 'invalid') return rejectWsInput(input.issues);
        const result = await memecoinAggregator.closePosition(input.data.positionId, input.data.sellPct);
        ws.send(JSON.stringify({ type: 'POSITION_CLOSED_RESULT', data: result }));
      }
      if (parsed.action === 'PANIC_LIQUIDATE') {
        // P1.4 (N-2): the same emergency stop as the HTTP panic, so it also kills auto (it used to only sell)
        const result = await walletTrader.panicLiquidateAll('ws panic');
        ws.send(JSON.stringify({ type: 'PANIC_LIQUIDATION_RESULT', data: result }));
      }
    } catch (err: any) {
      // P1.4 (N-6): a failed action is logged and answered; it used to be swallowed with no reply and no log line
      const action = typeof parsed?.action === 'string' ? parsed.action.slice(0, 64) : 'UNKNOWN';
      const error = err?.message || String(err);
      Logger.error(`[WS] ${action} failed: ${error}`);
      try { ws.send(JSON.stringify({ type: `${action}_RESULT`, success: false, error })); } catch { /* socket already closed */ }
    }
  });
});

// Broadcast real-time Pump.fun Hot Callouts updates
pumpFunService.on('callouts_updated', (data) => {
  broadcastWs({ type: 'PUMP_HOT_CALLOUTS', data });
});

pumpFunService.on('callout_sniped', (data) => {
  broadcastWs({ type: 'CALLOUT_SNIPED', data });
});

// G2: watch window. Create events start a watch, decoded TradeEvents feed it. A release is information for the board;
// it does not trade (the auto controller's own gates still decide).
watchWindow.setScoreFn((mint) => {
  const pool = memecoinAggregator.getPools().find((p) => p.contractAddress === mint);
  return pool ? memecoinAggregator.evaluateTokenConfluence(pool).score : null;
});
// P4.3 (R1-57): the measured curve progress (tokens sold); above APEX_MAX_CURVE_PROGRESS_PCT (60) a watched launch is released DEAD CURVE_TOO_FAR
watchWindow.setCurveProgressFn((mint) => onChainPoolStats.get(mint)?.curveProgressPct ?? null);
{ const p = maxCurveProgressProblem(); if (p) console.warn(`[APEX QUANT HFT] ${p}`); }
watchWindow.attach(pumpFeedListener);
pumpFeedListener.follow(executionCoordinator); // P4.2 (R1-63): a successful RPC switch moves the log subscription and creator lookups
// S178: save what the window sees (launches it scores, their trades, the funder facts) so the auto rules can be replayed over real launches
for (const p of recorderConfigProblems()) console.warn(`[APEX QUANT HFT] ${p}`); // S190
const launchRecorder = new LaunchRecorder(workstationDb, watchWindow, () => solPriceService.lastKnownPrice());
launchRecorder.attach(pumpFeedListener);
wireWatchPins(watchWindow, memecoinAggregator, onChainPoolStats, curveVelocityEvaluator); // S4: a watched mint keeps its pool, its trade stats and (P4.3) its velocity data until the verdict
wireCreatorReportPins(watchWindow, creatorRiskScorer); // P4.1: a watched launch's creator report lives until 60 s after its verdict
wireFunderLookup(watchWindow, new FunderLookup(() => executionCoordinator.getConnection())); // Q6b
watchWindow.on('release', (r) => broadcastWs({ type: 'WATCH_RELEASE', data: r }));
watchWindow.start();
autoSnipeController.attachWatchWindow(); // Q6f: HOT and READY releases are the auto candidates

// Broadcast real-time Pump.fun V2 WebSocket CreateEvents (B08)
pumpFeedListener.on('create_event', (data) => {
  broadcastWs({
    type: 'PUMP_CREATE_EVENT',
    data: {
      ...data,
      virtualTokenReserves: typeof data.virtualTokenReserves === 'bigint' ? data.virtualTokenReserves.toString() : data.virtualTokenReserves,
      virtualSolReserves: typeof data.virtualSolReserves === 'bigint' ? data.virtualSolReserves.toString() : data.virtualSolReserves,
      realTokenReserves: typeof data.realTokenReserves === 'bigint' ? data.realTokenReserves.toString() : data.realTokenReserves,
      realSolReserves: typeof data.realSolReserves === 'bigint' ? data.realSolReserves.toString() : data.realSolReserves,
      tokenTotalSupply: typeof data.tokenTotalSupply === 'bigint' ? data.tokenTotalSupply.toString() : data.tokenTotalSupply,
    },
  });
});

// Broadcast real-time memecoin aggregator sniper updates
memecoinAggregator.on('sniper_trade', (data) => {
  broadcastWs({ type: 'SNIPER_TRADE', data }, true);
});

memecoinAggregator.on('position_closed', (data) => {
  broadcastWs({ type: 'POSITION_CLOSED', data }, true);
});

memecoinAggregator.on('price_update', (data) => {
  broadcastWs({ type: 'MEMECOIN_PRICE_UPDATE', data });
});

memecoinAggregator.on('config_updated', (data) => {
  broadcastWs({ type: 'SNIPER_CONFIG_UPDATED', data });
});

walletTrader.on('wallet_state_updated', (data) => {
  broadcastWs({ type: 'WALLET_STATE_UPDATED', data }, true);
});

walletTrader.on('trade_executed', (data) => {
  broadcastWs({ type: 'WALLET_TRADE_EXECUTED', data }, true);
});

app.use(correlationIdMiddleware);
app.use(securityHeadersMiddleware);

// Restrictive Cross-Origin Resource Sharing (CORS) Policy
const corsPolicy: cors.CorsOptionsDelegate<cors.CorsRequest> = (req, callback) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || isAllowedClientOrigin(origin, host)) {
    return callback(null, {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token', 'x-operator-auth', 'x-correlation-id'],
    });
  }
  return callback(null, { origin: false });
};
app.use(cors(corsPolicy));

app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use('/api', rateLimiter({ maxTokens: Number(process.env.APEX_RATE_LIMIT_BURST) || 120, refillRatePerSec: 30 }));
// A1: deny-by-default. Only GET /api/health and POST /api/auth/login are reachable without an operator token.
app.use(apiAuthGate);

// ============================================================================
// OPERATOR AUTHENTICATION & SESSION MANAGEMENT
// ============================================================================
// 3G (N-5): password guessing gets its own, much tighter, per-address limit on top of the /api one.
app.post('/api/auth/login', rateLimiter(LOGIN_RATE_LIMIT), (req, res) => {
  const { password, token } = req.body || {};
  const authRes = authManager.authenticateOperator({ password, token });
  if (!authRes.success) {
    return res.status(401).json(authRes);
  }
  res.json({
    success: true,
    token: authRes.token,
    role: 'OPERATOR',
  });
});

app.post('/api/auth/rotate', requireOperatorAuth, (req, res) => {
  const newToken = authManager.rotateOperatorToken();
  res.json({
    success: true,
    message: 'Operator session credential successfully rotated.',
    token: newToken,
  });
});

app.get('/api/auth/session', (req, res) => {
  // Check authorization header or session header
  const authHeader = req.headers['authorization'];
  const provided = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.slice(7).trim()
    : req.headers['x-session-token'];

  if (provided && authManager.validateToken(String(provided))) {
    return res.json({
      success: true,
      token: provided,
      role: authManager.isOperatorToken(String(provided)) ? 'OPERATOR' : 'READONLY', // T3: the session's own role, not a constant
    });
  }

  return res.status(401).json({
    success: false,
    error: 'Authentication required. POST /api/auth/login with operator password or provide Authorization Bearer token.',
  });
});

app.get('/api/auth/status', (req, res) => {
  const authHeader = req.headers['authorization'];
  let token: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers['x-session-token']) {
    token = String(req.headers['x-session-token']).trim();
  } else if (req.headers['x-operator-auth']) {
    token = String(req.headers['x-operator-auth']).trim();
  }
  const valid = authManager.validateToken(token);
  res.json({ success: true, authenticated: valid });
});

app.post('/api/auth/logout', requireOperatorAuth, (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-session-token'] as string);
  if (token) authManager.revokeToken(token);
  res.json({ success: true, message: 'Operator session terminated' });
});

// Initialize Gemini client lazily
let genAiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI | null {
  if (!genAiClient && process.env.GEMINI_API_KEY) {
    try {
      genAiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    } catch (e) {
      console.error('Failed to initialize Gemini SDK:', e);
    }
  }
  return genAiClient;
}

// 1. Health check & Honest System Telemetry
app.get('/api/health', (req, res) => {
  res.json(publicHealthBody());
});


// 3. (removed, 3H/B1) /api/market/orderbook, /api/market/trades and /api/market/ticker proxied Binance (BTCUSDT by default), left over from
// the BTC market maker; no screen called them. The curve panel's /api/market/curve/:mint and /api/market/trades/:mint are separate and stay.
// 3h. (removed, Q57) /api/account/balance was a Binance-testnet route with invented "institutional" balances and hardcoded BTC/ETH prices; nothing in src/ called it.

// 4. (removed) /api/unit-tests ran 700 arithmetic self-checks on toy numbers; System checks (/api/system/checks) reads live state instead.

// 5. Quant AI Diagnostics: the model is given the server's own live state (system checks, auto journal stats, measured latency), built
// here from the same sources the screens read. The client sends only the mode and the question; it cannot add figures.
app.post('/api/ai/diagnostics', requireOperatorAuth, asyncHandler(async (req, res) => {
  const { mode = 'thinking', prompt } = req.body ?? {};
  const ai = getGenAI();

  if (!ai) {
    return res.status(503).json({
      error: 'GEMINI_API_KEY is not configured. Set it in .env and restart to use Quant AI Diagnostics (nothing is sent anywhere without it).',
    });
  }

  const context = buildDiagnosticsContext();
  try {
    if (mode === 'thinking') {
      const systemInstruction = `You review a Solana pump.fun auto-trading workstation (devnet / paper). Use ONLY the JSON state given; if a figure is missing or null say it is not measured, never estimate it.
Answer with: 1. What the state shows (cite the check or counter), 2. What looks wrong or risky, 3. What to look at next. Be short and concrete. You cannot trade and nothing you say is executed.`;
      const userMessage = `Live state:\n${JSON.stringify(context, null, 2)}\n\nQuestion: ${prompt || 'Review this state and point out anything that needs attention.'}`;
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [{ role: 'user', parts: [{ text: `${systemInstruction}\n\n${userMessage}` }] }],
        config: { thinkingConfig: { thinkingLevel: 'HIGH' as any } },
      });
      return res.json({ model: 'gemini-3.1-pro-preview', thinkingEnabled: true, analysis: response.text || 'Analysis completed.', context });
    }
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt || 'What is the current state of pump.fun launch activity on Solana?',
      config: { tools: [{ googleSearch: {} }] },
    });
    return res.json({
      model: 'gemini-3.5-flash',
      grounded: true,
      analysis: response.text || 'Market search completed.',
      groundingMetadata: response.candidates?.[0]?.groundingMetadata,
    });
  } catch (err: any) {
    console.error('Gemini API Error:', err);
    res.status(500).json({ error: err.message || 'Error processing AI Diagnostics' });
  }
}));

// 6. (removed, 3H/B2) /api/export/packets wrapped whatever the client posted in made-up PCAP header fields; no screen called it.

// ============================================================================
// 12. SOCIAL SCANNER (TELEGRAM & X.COM) ALPHA INTELLIGENCE ENDPOINTS
// ============================================================================
app.get('/api/social/signals', requireOperatorAuth, (req, res) => {
  res.json({
    status: 'OK',
    count: socialScanner.getSignals().length,
    signals: socialScanner.getSignals(),
  });
});

/**
 * S1: while LIVE is armed, EVERY entry point that can open a position needs `confirmLive: true` (the UI sends it after the operator
 * confirmed a dialog naming the cluster): the HTTP routes below, the two WebSocket snipe actions, and the Telegram /snipe and /buy
 * commands. This is a guard against an accidental or scripted one-click trade, NOT a security boundary: the flag is a client
 * assertion, and the operator token is what actually authorises the request.
 */
const liveGate = (body: unknown) => liveConfirmationRefusal(executionCoordinator.isLiveArmed(), allowedCluster(), body as { confirmLive?: unknown } | undefined);
const requireLiveConfirmation: express.RequestHandler = (req, res, next) => {
  const refusal = liveGate(req.body);
  if (!refusal) return next();
  res.status(409).json({ success: false, status: 'REJECTED', error: refusal, result: { success: false, message: refusal } });
};

app.post('/api/social/signals/snipe', requireOperatorAuth, validateTradeBody(SignalSnipeSchema), asyncHandler(async (req, res) => {
  const { signalId } = req.body;
  const unconfirmed = liveConfirmationRefusal(executionCoordinator.isLiveArmed(), allowedCluster(), req.body); // Q10b
  if (unconfirmed) return res.status(409).json({ success: false, status: 'REJECTED', error: unconfirmed });
  const existing = socialScanner.getSignals().find((s) => s.id === signalId);
  if (!existing) {
    return res.status(404).json({ error: 'Signal not found' });
  }
  // An unverified signal (live-ingested, no real scoring) must never reach a live trade.
  if (executionCoordinator.isLiveArmed() && existing.verified !== true) {
    return res.status(409).json({ error: 'UNVERIFIED_SIGNAL: refusing to snipe an unverified signal while LIVE is armed' });
  }
  // S181: an explicit size is judged before the signal is marked, so a refused amount leaves the signal snipeable.
  if (req.body.amountSol !== undefined) {
    const check = checkSnipeAmountSol(req.body.amountSol);
    if (!check.ok) return res.status(422).json({ success: false, status: 'REJECTED', error: check.reason });
  }
  const sig = socialScanner.markSniped(signalId)!;

  // Trigger sniper trade on the aggregator
  const tradeResult = await memecoinAggregator.executeSnipe({
    contractAddress: sig.contractAddress,
    amountUsd: req.body.amountUsd,
    operatorAmountSol: req.body.amountSol,
    platform: req.body.platform,
    jitoTipSol: req.body.jitoTipSol,
    slippagePct: req.body.slippagePct,
    signalId: sig.id,
    // Provenance comes from the stored signal (set when it was ingested), never from the request.
    provenance: sig.provenance,
    signalTimestamp: sig.timestamp,
  });

  res.json({
    status: 'OK',
    signal: sig,
    tradeResult,
  });
}));

app.get('/api/telegram/config', requireOperatorAuth, (req, res) => {
  res.json({
    status: 'OK',
    config: socialScanner.getTelegramConfigRedacted(),
  });
});

app.post('/api/telegram/config', requireOperatorAuth, (req, res) => {
  socialScanner.updateTelegramConfig(req.body);
  res.json({
    status: 'OK',
    config: socialScanner.getTelegramConfigRedacted(),
  });
});

app.post('/api/telegram/webhook', requireOperatorAuth, asyncHandler(async (req, res) => {
  const { message } = req.body;
  const text = message?.text || req.body?.text || '';
  // Q23: /snipe and /buy are one-click trades, so they need the same live confirmation as the other trade routes
  if (isTelegramTradeCommand(text)) {
    const unconfirmed = liveConfirmationRefusal(executionCoordinator.isLiveArmed(), allowedCluster(), req.body);
    if (unconfirmed) return res.status(409).json({ ok: false, result: { reply: `❌ SNIPE REJECTED: ${unconfirmed}` } });
  }
  const result = await socialScanner.processTelegramCommand(text);

  res.json({
    ok: true,
    result,
  });
}));

app.post('/api/telegram/test-connection', requireOperatorAuth, asyncHandler(async (req, res) => {
  const { botToken, chatId, sendPingMessage } = req.body || {};
  const testResult = await socialScanner.testTelegramConnection(botToken, chatId, sendPingMessage);
  res.json(testResult);
}));

app.post('/api/social/test-twitter', requireOperatorAuth, asyncHandler(async (req, res) => {
  const { bearerToken } = req.body || {};
  const testResult = await socialScanner.testXTwitterConnection(bearerToken);
  res.json(testResult);
}));

// Full External Connectivity Diagnostics & Simulation Scope Audit
app.get('/api/connectivity/diagnostics', requireOperatorAuth, asyncHandler(async (req, res) => {
  const tStart = Date.now();

  // 1. Telegram
  const telegramTest = await socialScanner.testTelegramConnection();

  // 1b. X.com / Twitter Probe
  const xTwitterTest = await socialScanner.testXTwitterConnection();

  // 2. Pump.fun Live Feed Probe
  const tPump = performance.now();
  const pumpTest: any = { reachable: false, latencyMs: 0, status: null, tokensCount: 0, sampleMint: null };
  try {
    const pumpRes = await fetch(
      'https://frontend-api-v3.pump.fun/coins?offset=0&limit=5&sort=last_trade_timestamp&order=DESC&includeNsfw=false',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json',
        },
      }
    );
    pumpTest.latencyMs = Math.round(performance.now() - tPump);
    pumpTest.status = pumpRes.status;
    if (pumpRes.ok) {
      const coins = await pumpRes.json();
      pumpTest.reachable = true;
      pumpTest.tokensCount = coins.length;
      pumpTest.sampleMint = coins[0]?.mint || null;
      pumpTest.newestToken = coins[0]?.name ? `${coins[0].name} (${coins[0].symbol})` : null;
    }
  } catch (e: any) {
    pumpTest.error = e.message;
    pumpTest.latencyMs = Math.round(performance.now() - tPump);
  }

  // 3. DexScreener Live Boosted Probe
  const tDex = performance.now();
  const dexTest: any = { reachable: false, latencyMs: 0, status: null, boostedCount: 0 };
  try {
    const dexRes = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    dexTest.latencyMs = Math.round(performance.now() - tDex);
    dexTest.status = dexRes.status;
    if (dexRes.ok) {
      const boosts = await dexRes.json();
      dexTest.reachable = true;
      dexTest.boostedCount = Array.isArray(boosts) ? boosts.length : 0;
      dexTest.sampleToken = boosts[0]?.tokenAddress || null;
    }
  } catch (e: any) {
    dexTest.error = e.message;
    dexTest.latencyMs = Math.round(performance.now() - tDex);
  }

  // 4. Solana Mainnet Validator RPC Probe
  const tSol = performance.now();
  const solanaTest: any = { reachable: false, latencyMs: 0, health: null, slot: null };
  try {
    const rpcRes = await fetch(resolveRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'getHealth' },
        { jsonrpc: '2.0', id: 2, method: 'getSlot' },
      ]),
    });
    solanaTest.latencyMs = Math.round(performance.now() - tSol);
    if (rpcRes.ok) {
      const rpcData = await rpcRes.json();
      solanaTest.reachable = true;
      solanaTest.health = rpcData[0]?.result || 'ok';
      solanaTest.slot = rpcData[1]?.result || null;
    }
  } catch (e: any) {
    solanaTest.error = e.message;
    solanaTest.latencyMs = Math.round(performance.now() - tSol);
  }

  // 5. Coinbase Institutional Spot Feed Probe
  const tCb = performance.now();
  const coinbaseTest: any = { reachable: false, latencyMs: 0, btcPriceUsd: null };
  try {
    const cbRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
    coinbaseTest.latencyMs = Math.round(performance.now() - tCb);
    if (cbRes.ok) {
      const cbData = await cbRes.json();
      coinbaseTest.reachable = true;
      coinbaseTest.btcPriceUsd = parseFloat(cbData?.data?.amount || '0');
    }
  } catch (e: any) {
    coinbaseTest.error = e.message;
    coinbaseTest.latencyMs = Math.round(performance.now() - tCb);
  }

  // 6. Market Maker & Caller Profiles State
  const leaderboard = pumpFunService.getLeaderboard();
  const hotCallouts = pumpFunService.getHotCallouts();
  const confluenceCallouts = hotCallouts.filter((c) => c.confluenceCount >= 2);

  res.json({
    timestamp: Date.now(),
    totalAuditTimeMs: Date.now() - tStart,
    cluster: allowedCluster(), // Q10a: the cluster this server is configured for, shown next to the RPC probe
    connections: {
      xTwitter: {
        service: 'X.com / Twitter API v2 (api.twitter.com)',
        isLiveExternal: true,
        testResult: xTwitterTest,
      },
      telegram: {
        service: 'Telegram Bot API (api.telegram.org)',
        isLiveExternal: true,
        testResult: telegramTest,
      },
      pumpFun: {
        service: 'Pump.fun High-Velocity Stream (frontend-api-v3.pump.fun)',
        isLiveExternal: true,
        testResult: pumpTest,
      },
      dexScreener: {
        service: 'DexScreener Boosted & AMM Stream (api.dexscreener.com)',
        isLiveExternal: true,
        testResult: dexTest,
      },
      solanaRpc: {
        service: `Solana RPC (${new URL(resolveRpcUrl()).host})`,
        isLiveExternal: true,
        testResult: solanaTest,
      },
      coinbase: {
        service: 'Coinbase Institutional Spot Price Feed (api.coinbase.com)',
        isLiveExternal: true,
        testResult: coinbaseTest,
      },
    },
    marketMakerProfiles: {
      totalProfiles: leaderboard.length,
      profiles: leaderboard.map((p) => ({
        userId: p.userId,
        primaryWallet: p.primaryWallet,
        reputationTier: p.reputationTier,
        winRate2x: `${p.winRate2x}%`,
        avgMultiple: `${p.avgMultiple}x`,
        avgTimeToPeak: `${Math.round(p.avgTimeToPeakMs / 60000)}m`,
        followers: p.followersCount,
      })),
      activeCalloutsCount: hotCallouts.length,
      multiCallerConfluenceCount: confluenceCallouts.length,
      // Q33: what "confluence" is here, said where it is shown
      confluenceMeaning: 'The token is on both the pump.fun recent list and the DexScreener paid-boost list. The listed callers are placeholder names assigned by list position, not people who called it.',
      confluenceTokens: confluenceCallouts.map((c) => ({
        symbol: c.token.symbol,
        mint: c.token.mint,
        action: c.hftAction,
        confluenceCount: c.confluenceCount,
        callers: [`@${c.caller.userId}`, ...(c.otherCallers ?? [])],
      })),
    },
    simulationScopeMatrix: [
      {
        subsystem: 'Pump.fun Token Discovery & Velocity',
        nature: allowedCluster() === 'mainnet-beta' ? 'LIVE' : 'NOT_AVAILABLE_ON_THIS_CLUSTER',
        details: allowedCluster() === 'mainnet-beta'
          ? 'New launches and trades come from the program log stream (PumpFeedListener) on the configured RPC; the pump.fun HTTP API adds metadata.'
          : `Cluster is ${allowedCluster()}: the pump.fun HTTP API only serves mainnet, so it yields no candidates here. Launches appear only if the pump program is deployed on this cluster and something creates tokens on it (the log stream reads the configured RPC).`,
      },
      {
        subsystem: 'DexScreener Boosted & Pool Metrics',
        nature: allowedCluster() === 'mainnet-beta' ? 'LIVE' : 'NOT_AVAILABLE_ON_THIS_CLUSTER',
        details: allowedCluster() === 'mainnet-beta'
          ? 'Boosted tokens and 5-minute buy/sell ratios from api.dexscreener.com.'
          : 'DexScreener indexes mainnet only; it has no data for devnet or localnet tokens.',
      },
      {
        subsystem: 'Multi-Caller Confluence Engine',
        nature: 'LIVE_COMPUTATION',
        details:
          'Scores a candidate from the signals it is given (score gate 70, maximum reachable 90 because the Social component is 0). It computes only from what the discovery sources above supply, so on devnet it scores watch-window candidates, not DexScreener boosts.',
      },
      {
        subsystem: 'Auto mode (OFF / SHADOW / PAPER / DEVNET_LIVE)',
        nature: 'PAPER_BY_DEFAULT',
        details:
          'Candidates come from the watch window (HOT/READY releases). PAPER fills and exits use the real curve maths, fees and tips, so a round trip at an unchanged curve loses about 3% plus tips; profit needs real price moves. PAPER has its own session budgets. Liquidity and distribution score components stay 0 until the pool has enough real SOL and 30 distinct buyers. DEVNET_LIVE is the only mode that signs transactions.',
      },
      {
        subsystem: 'Telegram Bot API Link',
        nature: 'PARTIAL',
        details:
          'The command handler (/snipe, /signals, /positions, /status, /panic_sell) runs when something posts to the operator-authenticated /api/telegram/webhook. NOT implemented: setWebhook registration with Telegram, getUpdates polling, and alert forwarding. Outbound connectivity can be tested with a bot token; nothing is sent automatically.',
      },
      xTwitterScopeEntry(xTwitterTest, allowedCluster()),
      {
        subsystem: 'Coinbase Spot Reference',
        nature: 'LIVE',
        details: 'Queries live BTC-USD spot price directly from api.coinbase.com.',
      },
      {
        subsystem: 'Order Execution & Paper Trading',
        nature: executionCoordinator.isLiveArmed() ? 'LIVE_ARMED' : 'PAPER_BY_DEFAULT',
        details: executionCoordinator.isLiveArmed()
          ? 'LIVE is ARMED: snipes are signed with the configured wallet and submitted to the configured cluster RPC. Real funds on that cluster are at risk.'
          : isReadOnly()
            ? 'READ-ONLY: this server has no signer and cannot arm LIVE. Snipes are paper-traded against the real curve quote; no transaction is signed or sent.'
            : 'LIVE is not armed: snipes are paper-traded in memory against the curve quote. No transaction is signed or sent.',
      },
      {
        subsystem: 'Jito MEV Bundles & Priority Tips',
        nature: executionCoordinator.isLiveArmed() ? 'LIVE_CLUSTER_DEPENDENT' : 'PAPER_ONLY',
        details: isReadOnly()
          ? 'Read-only mode: nothing is signed or sent, so no tip is ever paid. Paper fills still model the priority tip from the tip policy (on mainnet it follows the public Jito tip floor) so their cost is what a real send would pay.'
          : 'Priority tips follow the executionConfig tip policy. Bundles go to Jito only on mainnet-beta (never enabled by default); on devnet or localnet the transaction goes to the cluster RPC with a priority fee and no bundle. In paper mode nothing is sent.',
      },
      {
        subsystem: 'Caller Persona Historical Track Records',
        nature: 'NOT_VERIFIED',
        details:
          'Caller personas and their win rates are static configuration, not measured track records. Do not treat them as evidence about a caller.',
      },
      {
        subsystem: 'Microstructure & Latency Stress',
        nature: 'MATHEMATICAL_MODEL',
        details:
          'Standalone formula calculators (Avellaneda-Stoikov, square-root impact). Their latency inputs are assumptions, not measurements, and they do not drive live order routing.',
      },
    ],
  });
}));

// ============================================================================
// 13. MULTI-PLATFORM MEMECOIN AGGREGATOR & SNIPER ENGINE ENDPOINTS
// ============================================================================
app.get('/api/memecoins/pools', requireOperatorAuth, (req, res) => {
  const { platform, chain } = req.query;
  const pools = memecoinAggregator.getPools(platform as string, chain as string);
  res.json({
    status: 'OK',
    count: pools.length,
    pools,
  });
});

app.get('/api/memecoins/positions', requireOperatorAuth, (req, res) => {
  res.json({
    status: 'OK',
    positions: memecoinAggregator.getPositions(),
  });
});

app.post('/api/memecoins/trade', requireOperatorAuth, requireLiveConfirmation, validateTradeBody(OperatorSnipeSchema), asyncHandler(async (req, res) => {
  const result = await memecoinAggregator.executeSnipe({ ...withOperatorAmount(req.body), provenance: OPERATOR_PROVENANCE, signalTimestamp: Date.now() });

  res.json({
    status: result.success ? 'OK' : 'REJECTED',
    result,
  });
}));

app.post('/api/memecoins/close', requireOperatorAuth, validateTradeBody(OperatorCloseSchema), asyncHandler(async (req, res) => {
  const { positionId, sellPct } = req.body;
  const result = await memecoinAggregator.closePosition(positionId, sellPct);
  res.json({
    status: result.success ? 'OK' : 'ERROR',
    result,
  });
}));

/** The bot token is write-only: it never leaves the server once stored. */
function redactSniperConfig<T extends { telegramBotToken?: string }>(c: T) {
  return { ...c, telegramBotToken: '', telegramBotTokenSet: Boolean(c.telegramBotToken) };
}

app.get('/api/memecoins/config', requireOperatorAuth, (req, res) => {
  res.json({
    status: 'OK',
    config: redactSniperConfig(memecoinAggregator.getConfig()),
    exitRules: exitRulesSummary(), // the fixed ExitEngine rules; config.takeProfitPct / stopLossPct do not drive exits
  });
});

app.post('/api/memecoins/config', requireOperatorAuth, validateTradeBody(SniperConfigPatchSchema), (req, res) => {
  // The UI never sees the stored token, so an empty field means "unchanged", not "erase".
  const patch = { ...req.body };
  if (!patch.telegramBotToken) delete patch.telegramBotToken;
  const updated = memecoinAggregator.updateConfig(patch);
  res.json({
    status: 'OK',
    config: redactSniperConfig(updated),
  });
});

// ============================================================================
// 13b. PUMP.FUN HOT CALLOUTS & CALLER LEADERBOARD (REAL-WORLD ENGINE)
// ============================================================================
app.get('/api/pumpfun/callouts', requireOperatorAuth, (req, res) => {
  const status = pumpFunService.getStatus();
  res.json({
    status: 'OK',
    liveSource: status.liveSource,
    syncLatencyMs: status.syncLatencyMs,
    lastUpdated: status.lastSyncTimestamp,
    tokensTrackedCount: status.tokensTrackedCount,
    callouts: pumpFunService.getHotCallouts(),
    leaderboard: pumpFunService.getLeaderboard(),
    autoSnipeRules: pumpFunService.getAutoSnipeRules(),
  });
});

app.get('/api/pumpfun/leaderboard', requireOperatorAuth, (req, res) => {
  res.json({
    status: 'OK',
    leaderboard: pumpFunService.getLeaderboard(),
  });
});

app.post('/api/pumpfun/callouts/snipe', requireOperatorAuth, validateTradeBody(CalloutSnipeSchema), asyncHandler(async (req, res) => {
  const { calloutId, amountUsd, amountSol, jitoTipSol, slippagePct } = req.body;
  const unconfirmed = liveConfirmationRefusal(executionCoordinator.isLiveArmed(), allowedCluster(), req.body); // Q10b
  if (unconfirmed) return res.status(409).json({ success: false, status: 'REJECTED', error: unconfirmed, result: { success: false, message: unconfirmed } });

  const result = await pumpFunService.snipeCallout(calloutId, amountUsd, jitoTipSol, slippagePct, amountSol);

  res.json({
    status: result.success ? 'OK' : 'REJECTED',
    result,
  });
}));

app.get('/api/pumpfun/callouts/rules', requireOperatorAuth, (req, res) => {
  res.json({
    status: 'OK',
    rules: pumpFunService.getAutoSnipeRules(),
  });
});

app.post('/api/pumpfun/callouts/rules', requireOperatorAuth, validateTradeBody(AutoSnipeRulesSchema), (req, res) => {
  const updated = pumpFunService.updateAutoSnipeRules(req.body);
  res.json({
    status: 'OK',
    rules: updated,
  });
});

app.get('/api/pumpfun/status', requireOperatorAuth, (req, res) => {
  res.json(pumpFunService.getStatus());
});

app.post('/api/pumpfun/refresh', requireOperatorAuth, asyncHandler(async (req, res) => {
  // A manual refresh only reloads the feed; it must never evaluate auto-snipe triggers (A5).
  const sync = await pumpFunService.syncRealWorldData({ evaluateTriggers: false });
  res.json({
    status: sync.skipped ? 'SKIPPED' : 'OK',
    ...(sync.skipped ? { reason: sync.skipped } : {}),
    calloutsCount: pumpFunService.getHotCallouts().length,
    timestamp: Date.now(),
  });
}));


// ============================================================================
// 15. PLUG-AND-PLAY WALLET ONBOARDING & LIVE AUTONOMOUS TRADING ENDPOINTS
// ============================================================================
app.get('/api/wallet/state', requireOperatorAuth, (req, res) => {
  res.json({
    success: true,
    data: walletTrader.getState(),
    config: walletTrader.getPublicConfig(), // Q54, 3G: RPC and Jito URLs as their origin only, no key from a path or query
  });
});

app.post('/api/wallet/config', requireOperatorAuth, validateBody(WalletConfigSchema), asyncHandler(async (req, res) => {
  try {
    await walletTrader.updateConfig(req.body);
    res.json({
      success: true,
      config: walletTrader.getPublicConfig(),
      state: walletTrader.getState(),
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message, state: walletTrader.getState() });
  }
}));

app.post('/api/wallet/toggle-trading', requireOperatorAuth, validateTradeBody(ArmSchema), (req, res) => {
  const { active, confirmationCode } = req.body;
  if (active) {
    const armRes = executionCoordinator.armLiveTrading(true, confirmationCode);
    if (!armRes.success) {
      return res.status(403).json({ success: false, error: armRes.message });
    }
  } else {
    executionCoordinator.armLiveTrading(false);
  }

  res.json({
    success: true,
    isLiveTradingActive: executionCoordinator.isLiveArmed(),
    state: walletTrader.getState(),
  });
});

app.post('/api/wallet/snipe', requireOperatorAuth, requireLiveConfirmation, validateBody(LiveSnipeOrderSchema), asyncHandler(async (req, res) => {
  // S181: same refusal-with-a-reason as the other snipe routes (minimum and MAX_POSITION_SIZE_SOL); nothing is clamped.
  const amountCheck = checkSnipeAmountSol(req.body.amountSol);
  if (!amountCheck.ok) return res.status(400).json({ success: false, error: amountCheck.reason });
  // The operator's request is the signal; a client-supplied signalTimestamp is ignored so the age check cannot be dodged.
  const result = await walletTrader.executeLiveSnipe({ ...req.body, signalTimestamp: Date.now() });
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({
    success: true,
    data: result,
    state: walletTrader.getState(),
  });
}));

app.post('/api/wallet/close-position', requireOperatorAuth, validateBody(ClosePositionSchema), asyncHandler(async (req, res) => {
  const { positionId, sellPct } = req.body;
  const result = await walletTrader.closePosition(positionId, sellPct, 'Manual user order');
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({
    success: true,
    data: result,
    state: walletTrader.getState(),
  });
}));

app.post('/api/wallet/panic-liquidate', requireOperatorAuth, asyncHandler(async (req, res) => {
  // P1.4 (N-1): one emergency stop. Auto is killed (after its buy in flight) BEFORE the positions are read, then every ACTIVE one is sold.
  const result = await walletTrader.panicLiquidateAll('panic liquidate');
  const failedList = result.failed.map((f) => `${f.symbol}: ${f.error}`).join('; ');
  res.json({
    success: result.failed.length === 0,
    message: `Emergency liquidation ${result.failed.length === 0 ? 'complete' : 'INCOMPLETE, positions still open'}. Attempted: ${result.attemptedCount}, Succeeded: ${result.succeeded.length}, Failed: ${result.failed.length}${failedList ? ` (${failedList})` : ''}. Kill switch on, live trading disarmed, ${result.autoStopped ? 'auto stopped' : `auto NOT confirmed stopped (${result.autoStopError ?? 'mode is not OFF'})`}.`,
    data: result,
    state: walletTrader.getState(),
  });
}));

app.post('/api/wallet/sync-rpc', requireOperatorAuth, asyncHandler(async (req, res) => {
  const solBalance = await walletTrader.syncRpcBalance();
  res.json({
    success: true,
    solBalance,
    state: walletTrader.getState(),
  });
}));

// ============================================================================
// 16. CANONICAL DIAGNOSTICS & SYSTEM ARCHITECTURE AUDIT (SECTION 64)
// ============================================================================
app.get('/api/diagnostics/system', requireOperatorAuth, (req, res) => {
  const diag = executionCoordinator.getDiagnostics();
  const signerStatus = localSigner.getStatus();
  const dbMetrics = workstationDb.getExecutionMetrics();
  const riskLimits = riskEngine.getLimits();

  res.json({
    success: true,
    timestamp: Date.now(),
    systemAudit: {
      mode: diag.executionMode,
      isLiveArmed: diag.liveTradingActive,
      killSwitchActive: diag.killSwitchActive,
      walletSolBalance: diag.walletSolBalance,
      walletPubkey: diag.activeWalletAddress,
      signerStatus,
      rpcEndpoint: endpointOrigin(diag.rpcEndpoint || resolveRpcUrl()), // Q54: the endpoint in use (it changes on a switch), host only
      allowedCluster: allowedCluster(),
      readOnly: isReadOnly(), // S185: the banner reads this
      rpcLatencyMs: diag.rpcLatencyMs,
      databaseFile: 'apex_workstation.db',
      dbDriver: 'node:sqlite (WAL mode enabled)',
      keypairStorage: 'Local filesystem (mode 0600) at .apex_trading_keypair.json',
      browserPrivateKeySecurity: 'Private keys are NEVER accepted via HTTP/WebSocket requests.',
    },
    riskControls: {
      tier: 'MICRO_10',
      maxPositionSol: riskLimits.maxPositionSol,
      maxDailyLossSol: riskLimits.maxDailyLossSol,
      maxAggregateExposureSol: riskLimits.maxAggregateExposureSol,
      dailyLossSoFarSol: riskEngine.getDailyLossSol(),
      // R28: the circuit breaker's own state, not the kill-switch flag (that one is systemAudit.killSwitchActive)
      circuitBreakerState: riskEngine.getCircuitBreakerState(),
      circuitBreakerTripped: riskEngine.getCircuitBreakerState() === 'OPEN',
    },
    executionMetrics: dbMetrics,
  });
});

// System checks and measured latency: live reads, each from the component that owns the fact (see server/system/*).
app.get('/api/system/checks', requireOperatorAuth, (req, res) => {
  res.json({ success: true, ...buildSystemChecks() });
});

app.get('/api/system/latency', requireOperatorAuth, (req, res) => {
  const txs = workstationDb.loadTransactions().sort((a, b) => b.submissionTime - a.submissionTime).slice(0, 5000);
  const queued = workstationDb.loadDecisions({ stage: 'queue', outcome: 'QUEUED', limit: 5000 }).map((d) => ({ ts: d.ts, mint: d.mint }));
  res.json({ success: true, measuredAt: Date.now(), ...computeLatency(txs, queued) });
});

// Backtest = replay of recorded launches through the auto trader's real rules. No recording, no result.
app.get('/api/backtest/recording', requireOperatorAuth, (req, res) => {
  res.json({ success: true, ...workstationDb.getLaunchRecordingStatus() });
});

/** The most launches one replay covers (newest first). 3,250 launches replay in about 7 s of CPU, now time-sliced so the live loop keeps running. APEX_REPLAY_MAX_LAUNCHES (100 to 50000) overrides. */
function replayLaunchCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.APEX_REPLAY_MAX_LAUNCHES ?? '').trim());
  return Number.isInteger(n) && n >= 100 && n <= 50_000 ? n : 5_000;
}
let replayCache: { key: string; at: number; body: any } | null = null;
const replayInFlight = new Map<string, Promise<any>>();
app.get('/api/backtest/replay', requireOperatorAuth, asyncHandler(async (req, res) => {
  // S187: ?minScore=N replays at another confluence threshold (the what-if box); without it, the threshold in force
  let minScore: number | undefined;
  if (req.query.minScore !== undefined) {
    const c = checkConfluenceThreshold(req.query.minScore);
    if (!c.ok) return res.status(422).json({ success: false, error: c.reason });
    minScore = c.value;
  }
  const status = workstationDb.getLaunchRecordingStatus();
  if (status.launches === 0) {
    return res.json({ success: true, recorded: status, report: null, message: 'No launch has been recorded yet, so there is nothing to replay. The recorder saves every launch the watch window scores while the app runs against a pump.fun feed.' });
  }
  const cap = replayLaunchCap();
  const key = replayCacheKey(status, minScore ?? getConfluenceThreshold(), cap);
  if (replayCache && replayCache.key === key && Date.now() - replayCache.at < 30_000) return res.json(replayCache.body);
  try {
    // S189: one replay per key at a time (the screen polls), time-sliced so a long replay never stalls the live feed or the auto controller
    let running = replayInFlight.get(key);
    if (!running) {
      running = (async () => {
        const { launches, funders } = workstationDb.loadLaunchRecording(cap);
        // 5A: the recorder's window and trade cap tell the replay how far each recording reaches (a quiet coin's stale exit is then visible)
        const rc = recorderConfig();
        const report = await replayLaunchesAsync(launches, funders, solPriceService.lastKnownPrice(), { ...(minScore === undefined ? {} : { minScore }), recordedForMs: rc.mintMs, recordedMaxTrades: rc.maxTradesPerMint });
        // S188: the replay covers the newest `cap` launches; the response says so, so a count below the recorder's is explained
        const body = { success: true, recorded: status, report, message: null, replayedLaunches: launches.length, replayCap: cap };
        replayCache = { key, at: Date.now(), body };
        return body;
      })().finally(() => replayInFlight.delete(key));
      replayInFlight.set(key, running);
    }
    res.json(await running);
  } catch (e: any) {
    res.status(500).json({ success: false, error: `Replay failed: ${e?.message || e}` });
  }
}));

app.get('/api/execution/mode', requireOperatorAuth, (req, res) => {
  res.json({
    success: true,
    mode: executionCoordinator.getExecutionMode(),
    isLiveArmed: executionCoordinator.isLiveArmed(),
  });
});

app.get('/api/execution/can-arm', requireOperatorAuth, (req, res) => {
  res.json({
    success: true,
    ...executionCoordinator.canExecuteLive(),
  });
});

app.get('/api/execution/readiness', requireOperatorAuth, (req, res) => {
  res.json({
    success: true,
    ...executionCoordinator.getLiveReadiness(),
  });
});

/** S181: the schemas carry the client's size as amountSol; the aggregator takes it as operatorAmountSol. */
function withOperatorAmount<T extends { amountSol?: number }>(body: T): T & { operatorAmountSol?: number } {
  return { ...body, operatorAmountSol: body.amountSol };
}

app.get('/api/snipe/limits', requireOperatorAuth, (req, res) => {
  res.json({ success: true, ...getSnipeLimits(solPriceService.lastKnownPrice()) });
});

app.post('/api/auto/budget', requireOperatorAuth, validateTradeBody(AutoBudgetSchema), (req, res) => {
  const result = autoSnipeController.setBudget({ maxBuys: req.body.maxBuys, maxSpendSol: req.body.maxSpendSol });
  res.status(result.ok ? 200 : 422).json({ success: result.ok, ...result, error: result.reason, status: autoSnipeController.getStatus() });
});

app.post('/api/auto/order-size', requireOperatorAuth, validateTradeBody(AutoOrderSizeSchema), (req, res) => {
  const result = autoSnipeController.setOrderSol(req.body.orderSol);
  res.status(result.ok ? 200 : 422).json({ success: result.ok, ...result, error: result.reason, status: autoSnipeController.getStatus() });
});

/** S187: the one confluence buy threshold (watch window HOT gate and execution gate, manual snipes included). Works in read-only mode: it changes what is bought, never whether anything can be sent. */
app.post('/api/auto/threshold', requireOperatorAuth, validateTradeBody(AutoThresholdSchema), (req, res) => {
  const result = autoSnipeController.setConfluenceThreshold(req.body.threshold);
  res.status(result.ok ? 200 : 422).json({ success: result.ok, ...result, error: result.reason, status: autoSnipeController.getStatus() });
});

// G1: auto-snipe controller. The mode is saved; a restart brings it back up to PAPER (a saved DEVNET_LIVE returns as SHADOW).
app.get('/api/auto/status', requireOperatorAuth, (req, res) => {
  res.json({ success: true, ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats(), decisions: autoSnipeController.getDecisions(100) });
});

app.post('/api/auto/mode', requireOperatorAuth, validateTradeBody(AutoModeSchema), asyncHandler(async (req, res) => {
  const { mode, confirmationCode } = req.body;
  const result = await autoSnipeController.setMode(mode, { confirmationCode });
  res.status(result.ok ? 200 : 409).json({ success: result.ok, ...result, status: autoSnipeController.getStatus() });
}));

app.post('/api/auto/kill', requireOperatorAuth, validateTradeBody(AutoKillSchema), asyncHandler(async (req, res) => {
  const result = await autoSnipeController.kill({ exitAll: req.body.exitAll, reason: req.body.reason });
  res.json({ success: true, ...result, status: autoSnipeController.getStatus() });
}));

// H2: bonding-curve depth ladder and the selected mint's trade tape. When the source fails: 503, no generated rows.
const tradeTape = new TradeTape(
  (mint) => pumpFeedListener.getCreatorForMint(mint),
  () => {
    try {
      return localSigner.getStatus() === 'READY' ? localSigner.getPublicKey().toBase58() : null;
    } catch {
      return null;
    }
  }
);
tradeTape.attach(pumpFeedListener);

app.get('/api/market/curve/:mint', requireOperatorAuth, asyncHandler(async (req, res) => {
  try {
    const mint = new PublicKey(String(req.params.mint));
    const mode = executionCoordinator.getExecutionMode();
    const state = await PumpCurveService.fetchPumpMarketState({ connection: executionCoordinator.getConnection(), mint, executionMode: mode });
    if (!state) return res.status(503).json({ success: false, source: 'UNAVAILABLE', error: 'bonding curve state could not be read' });
    const held = workstationDb.loadPositions(undefined, 'ACTIVE').find((p) => p.mint === mint.toBase58());
    const depth = buildCurveDepth(state, { mode, positionTokensRaw: held ? BigInt(held.tokenQuantityRaw) : null });
    const sol = solPriceService.lastKnownPrice();
    res.json({
      success: true, ...depth, priceUsd: sol === null ? null : depth.spotPriceSol * sol, solUsd: sol,
      note: state.complete ? 'Migrated to PumpSwap: pool reserves are not read yet, so no ladder.' : null,
    });
  } catch (e: any) {
    res.status(503).json({ success: false, source: 'UNAVAILABLE', error: e?.message || 'curve unavailable' });
  }
}));

app.get('/api/market/trades/:mint', requireOperatorAuth, (req, res) => {
  const mint = String(req.params.mint);
  const rows = tradeTape.get(mint, 50);
  res.json({ success: true, mint, source: rows.length ? 'PUMP_TRADE_EVENTS' : 'NO_DATA', trades: rows });
});

app.get('/api/board', requireOperatorAuth, (req, res) => {
  res.json({ success: true, ...buildBoard() });
});

app.get('/api/watch', requireOperatorAuth, (req, res) => {
  res.json({ success: true, ...watchWindow.getSnapshot() });
});

app.post('/api/auto/resume', requireOperatorAuth, validateTradeBody(AutoResumeSchema), (req, res) => {
  res.json({ success: true, ...autoSnipeController.resume({ clearHalt: req.body.clearHalt, clearDailyLossLatch: req.body.clearDailyLossLatch, ackLossTriggers: req.body.ackLossTriggers }), status: autoSnipeController.getStatus() });
});

autoSnipeController.on('decision', (d) => broadcastWs({ type: 'AUTO_DECISION', data: d }));
autoSnipeController.on('mode', (d) => broadcastWs({ type: 'AUTO_MODE', data: { ...d, status: autoSnipeController.getStatus() } }));

app.post('/api/execution/arm', requireOperatorAuth, validateTradeBody(ArmSchema), (req, res) => {
  const { arm, confirmationCode } = req.body;
  // S185: read-only mode answers every arm request, arm or disarm, with 409 and does nothing.
  if (isReadOnly()) {
    return res.status(409).json({ success: false, error: 'READ_ONLY', message: 'READ_ONLY: APEX_READ_ONLY=true. This server watches and paper trades only; live trading cannot be armed.' });
  }
  const result = executionCoordinator.armLiveTrading(Boolean(arm), confirmationCode);
  if (!result.success) {
    return res.status(403).json(result);
  }
  res.json(result);
});

app.post('/api/execution/kill-switch', requireOperatorAuth, asyncHandler(async (req, res) => {
  // Explicit boolean only: an empty POST or {"activate":"false"} must not trip it, and must never silently reset it.
  const parsed = KillSwitchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success: false, error: 'activate must be true or false' });
  const { activate } = parsed.data;
  // P1.4 (N-0): tripping the switch is the shared emergency stop without the sells: kill switch, auto killed (OFF, after its buy in
  // flight) and LIVE disarmed. It used to leave auto in DEVNET_LIVE, which bought again once the switch was reset and LIVE re-armed.
  // F2: a reset also closes an open circuit breaker, but only when the latest wallet-balance read succeeded (resetCircuitBreaker).
  let breaker: ReturnType<typeof riskEngine.resetCircuitBreaker> | null = null;
  if (activate) await emergencyStop({ exitAll: false, reason: 'operator kill switch' });
  else {
    // The journal row says what the reset did to the breaker, next to G's KILL_SWITCH_TRIPPED reason.
    breaker = riskEngine.resetCircuitBreaker();
    riskEngine.setKillSwitch(false, `operator reset; circuit breaker ${breaker.state === 'CLOSED' ? 'closed' : `still open: ${breaker.reason}`}`);
  }
  res.json({
    success: true,
    killSwitchActive: riskEngine.isKillSwitchActive(),
    // R26: a reset does not lift an all-trading halt, and lifts an open circuit breaker only after a good balance read; say so, so the UI cannot claim "allowed again"
    circuitBreaker: riskEngine.getCircuitBreakerState(),
    ...(breaker ? { circuitBreakerReset: breaker } : {}),
    haltReason: executionCoordinator.getHaltReason(),
    autoMode: autoSnipeController.getMode(),
    message: activate ? 'EMERGENCY KILL SWITCH TRIPPED. All trading halted, auto OFF, LIVE disarmed.' : 'Kill switch reset. Auto stays OFF and LIVE stays disarmed until an operator turns them on.',
  });
}));

app.post('/api/execution/trade', requireOperatorAuth, requireLiveConfirmation, validateTradeBody(OperatorExecuteTradeSchema), asyncHandler(async (req, res) => {
  try {
    // Provenance and source are set here. A client cannot choose them (the schema rejects them).
    const result = await executionCoordinator.executeTrade({
      ...req.body,
      source: 'MANUAL',
      // The operator's request is the signal (K4a). The schema rejects a client-supplied signalTimestamp.
      signalTimestamp: Date.now(),
      provenance: OPERATOR_PROVENANCE,
    });
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}));

const OPERATOR_CLOSE_REASON = 'Operator close';
app.post('/api/execution/close', requireOperatorAuth, validateTradeBody(OperatorCloseSchema), asyncHandler(async (req, res) => {
  try {
    // P1.4 (N-3): the close reason is always "Operator close" (a protective reason: it runs during a halt, and is journaled as a manual
    // close). The client's text never becomes the reason, so it cannot label a close STOP_LOSS to skip the dust check; it is kept as a note.
    const { positionId, sellPct, reason: note } = req.body;
    const result = await executionCoordinator.closePosition(positionId, sellPct, OPERATOR_CLOSE_REASON);
    if (typeof note === 'string' && note.trim() && note !== OPERATOR_CLOSE_REASON) {
      const pos = workstationDb.loadPositions().find((p) => p.id === positionId);
      workstationDb.logDecision({ autoMode: 'n/a', mint: pos?.mint ?? '-', symbol: pos?.symbol, source: 'OPERATOR', stage: 'exit', outcome: 'INFO', reason: `operator close note: ${note.slice(0, 200)}`, positionId, inputs: { sellPct, closed: result.success } });
    }
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}));

app.post('/api/execution/reconcile', requireOperatorAuth, asyncHandler(async (req, res) => {
  try {
    const result = await executionCoordinator.startupReconciliation({ fresh: true }); // R17: a click never reads a run that began before it
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}));

app.get('/api/signer/status', requireOperatorAuth, (req, res) => {
  const status = localSigner.getStatus();
  const pubkey = status === 'READY' ? localSigner.getPublicKey().toBase58() : null;
  res.json({
    success: true,
    status,
    publicKey: pubkey,
  });
});

// Local wallet generation helper (imports must be done via CLI: npm run signer:import)
app.post('/api/signer/generate', requireOperatorAuth, (req, res) => {
  try {
    // S186: a read-only server never holds a key, so it cannot create one either
    if (isReadOnly()) {
      return res.status(409).json({ success: false, error: 'READ_ONLY', message: 'READ_ONLY: APEX_READ_ONLY=true: this server holds no signing key and cannot generate or import one.' });
    }
    if (req.body?.forceOverwrite) {
      return res.status(403).json({
        success: false,
        error: 'Overwriting an existing keypair over HTTP is disabled. Back it up and replace it with: npm run signer:import',
      });
    }
    // Q5: positions bought with the current key can only be sold with it
    if (workstationDb.loadPositions('LIVE', 'ACTIVE').length > 0) {
      return res.status(409).json({ success: false, error: 'A signing key already exists for the open LIVE positions; it is not replaced while they are open.' });
    }
    const pubkey = localSigner.generateNewKeypair(false);
    res.json({
      success: true,
      publicKey: pubkey,
      message: 'New local keypair generated and saved to .apex_trading_keypair.json with 0600 permissions. Fund this wallet with ~0.07 SOL to trade.',
    });
  } catch (err: any) {
    const status = err.message?.includes('already exists') ? 409 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.get('/api/workstation/positions', requireOperatorAuth, (req, res) => {
  const mode = (req.query.mode as any) || undefined;
  const status = (req.query.status as any) || undefined;
  const positions = executionCoordinator.getPositions(mode, status);
  res.json({
    success: true,
    count: positions.length,
    positions,
  });
});

app.get('/api/workstation/events', requireOperatorAuth, (req, res) => {
  // 3G (N-10): 1..200, else 50. A negative limit reached SQLite as LIMIT -1 (no limit) and NaN was bound as is.
  const n = Number.parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : 50;
  const events = workstationDb.getEvents(limit);
  res.json({
    success: true,
    count: events.length,
    events,
  });
});

// R10s: an unknown /api path is a 404 JSON, never the SPA's index.html with a 200 (the auth gate has already answered unauthenticated callers).
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `No such API route: ${req.method} ${req.path}` });
});

// Centralized error-handling middleware
app.use(errorHandler);

// Vite middleware & Static SPA serving
// One bad request must not take down the server and the trade monitor. Log it loudly and keep serving; the operator sees it in the logs.
process.on('unhandledRejection', (reason) => {
  Logger.error(`[PROCESS] unhandledRejection (process kept alive): ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  Logger.error(`[PROCESS] uncaughtException (process kept alive): ${err?.stack || err?.message || String(err)}`);
});

async function startServer() {
  await tracingReady; // S209: instrumentation must be in place before any outbound connection is made
  assertReadOnlyStartup(); // S185: refuses to start next to a signing key in read-only mode
  { const p = envConfluenceProblem(); if (p) console.warn(`[APEX QUANT HFT] ${p}`); } // S187
  if (process.env.NODE_ENV !== 'production') {
    const customLogger = createLogger();
    const originalError = customLogger.error.bind(customLogger);
    customLogger.error = (msg, options) => {
      if (
        msg.includes('ws error') ||
        msg.includes('1006') ||
        msg.includes('Invalid WebSocket frame') ||
        (options?.error && String(options.error).includes('1006'))
      ) {
        return;
      }
      originalError(msg, options);
    };

    const vite = await createViteServer({
      server: viteDevServerOptions(),
      appType: 'spa',
      customLogger,
    });
    // The project root is the Vite root: refuse secret and state files (env.txt, *.db, *.wal, *.log, keypairs, .overnight/...) before Vite sees the URL.
    app.use(secretPathGuard(process.cwd()));
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Test/offline switch: the behaviour tests spawn this server and must not reach Coinbase, CoinGecko, Binance, pump.fun or
  // DexScreener (the vitest network guard cannot see child processes). Production leaves it unset.
  const externalFeedsDisabled = process.env.APEX_DISABLE_EXTERNAL_FEEDS === 'true';
  solPriceService.startForBoot(externalFeedsDisabled); // feeds off + localnet: one refresh so LOCALNET_FIXED is set; feeds off elsewhere: nothing
  const pumpBoot = pumpBootMode();
  if (pumpBoot !== 'OFF') pumpFunService.startBackground({ httpPollers: pumpBoot === 'FULL' }); // S28: WS_ONLY = log stream only, no HTTP pollers
  // N18: bound the append-only audit tables (default 90 days; APEX_RETENTION_DAYS, 0 disables). Once at boot, then daily.
  const retentionDays = process.env.APEX_RETENTION_DAYS === undefined ? 90 : Number(process.env.APEX_RETENTION_DAYS);
  const prune = () => {
    const r = workstationDb.pruneOldRows(retentionDays);
    if (r.riskDecisions + r.decisions + r.journal > 0) Logger.info(`Retention: pruned ${r.riskDecisions} risk decisions, ${r.decisions} decisions, ${r.journal} journal rows older than ${retentionDays} days`);
  };
  prune();
  setInterval(prune, 86_400_000).unref();
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[APEX QUANT HFT] Autonomous Execution Engine running on ${BIND_HOST}:${PORT}`);
    void startTrading();
  });
}

/** P1.1: runs once the port is ours. A second instance never gets here: the database lock or the listen error ended it first. */
async function startTrading() {
  try {
    executionCoordinator.start(); // takes the signer lock, then reconciliation, the exit loop and the feed heartbeat
    await autoSnipeController.restorePersisted(); // S222: the confluence threshold, and the auto mode up to PAPER, come back after a restart
    autoSnipeController.startMonitor(); // G3: kill-switch triggers and wallet audit (inert while the mode is OFF)
  } catch (err: any) {
    Logger.error(`[PROCESS] trading start refused, exiting: ${err?.message || err}`);
    process.exit(1);
  } finally {
    markBootDone();
  }
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer();
} else {
  markBootDone(); // P1.4: an in-process import (a test) starts no trading side, so no request waits for it
}

/** P1.4: an in-process test listens on `server` itself (startServer does not run under vitest) to drive the real routes with spies. */
export { app, server };
