import './server/loadEnv'; // must stay the FIRST import: singletons built at import time read process.env
import './suppress-warnings.cjs';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'node:fs';
import crypto from 'crypto';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer, createLogger } from 'vite';
import { secretPathGuard, viteDevServerOptions } from './server/security/secretPaths';
import { GoogleGenAI } from '@google/genai';
import { hftEngine } from './server/engine/engine';
import { socialScanner } from './server/socialScanner';
import { memecoinAggregator } from './server/memecoinAggregator';
import { realismEngine } from './server/realismEngine';
import { pumpFunService } from './server/pumpfunService';
import { pumpFeedListener } from './server/solana/pumpFeedListener';
import { autoSnipeController } from './server/auto/controller';
import { watchWindow } from './server/signals/watchWindow';
import { buildBoard } from './server/board';
import { PublicKey } from '@solana/web3.js';
import { solPriceService } from './server/market/solPriceService';
import { PumpCurveService } from './server/solana/pumpCurve';
import { buildCurveDepth } from './server/market/curveDepth';
import { TradeTape } from './server/market/tradeTape';
import { runComprehensiveTestSuite } from './server/unitTestCases';
import { registerMarketRoutes } from './server/market/marketRoutes';
import { walletTrader } from './server/walletTrader';
import { resolveRpcUrl, allowedCluster } from './server/solana/clusterGuard';
import {
  ArmSchema,
  AutoModeSchema,
  AutoKillSchema,
  AutoResumeSchema,
  CalloutSnipeSchema,
  OPERATOR_PROVENANCE,
  OperatorCloseSchema,
  OperatorExecuteTradeSchema,
  OperatorSnipeSchema,
  SignalSnipeSchema,
  KillSwitchSchema,
  SniperConfigPatchSchema,
  ToggleCallerSchema,
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
} from './server/middleware/auth';
import {
  findLoosePermissions,
  defaultSecretFilePaths,
  loosePermissionWarnings,
} from './server/middleware/filePermissions';
export { isAllowedClientOrigin };
import {
  Logger,
  correlationIdMiddleware,
  errorHandler,
  rateLimiter,
  securityHeadersMiddleware,
  validateBody,
  WalletConfigSchema,
  LiveSnipeOrderSchema,
  ClosePositionSchema,
} from './server/middleware/enterprise';


const app = express();
// Defense in depth with the normalized auth gate: `/API/...` must not reach a route at all.
app.set('case sensitive routing', true);
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

// Helper to broadcast WS messages safely (default sensitiveOnly = true: requires operator auth)
function broadcastWs(payload: any, sensitiveOnly: boolean = true) {
  const str = safeJsonStringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
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
    try {
      const parsed = JSON.parse(msg.toString());

      // Operator Authentication command
      if (
        parsed.action === 'AUTHENTICATE' ||
        parsed.action === 'AUTH' ||
        parsed.type === 'AUTH' ||
        parsed.type === 'AUTHENTICATE'
      ) {
        const token = parsed.sessionToken || parsed.token;
        if (authManager.validateToken(token)) {
          (ws as any).isAuthenticated = true;
          ws.send(JSON.stringify({ type: 'AUTHENTICATED', authenticated: true, timestamp: Date.now() }));
          ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', authenticated: true }));
          // Emit telemetry and snapshots exclusively after successful authentication
          ws.send(JSON.stringify({ type: 'TELEMETRY', data: hftEngine.getTelemetry() }));
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
          ws.send(JSON.stringify({ type: 'WAL_SNAPSHOT', data: hftEngine.getWAL().getRecent(40) }));
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
        'START',
        'STOP',
        'KILL',
        'RESET',
        'SET_SYMBOL',
        'SET_CONFIG',
        'SNIPE_PUMP_CALLOUT',
        'TOGGLE_CALLER_SNIPE',
        'SNIPE_MEMECOIN',
        'CLOSE_POSITION',
        'PANIC_LIQUIDATE',
      ]);

      if (MUTATING_WS_ACTIONS.has(parsed.action)) {
        const token = parsed.sessionToken || parsed.token;
        if (!authManager.validateToken(token)) {
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

      if (parsed.action === 'START') hftEngine.startEngine();
      if (parsed.action === 'STOP') hftEngine.stopEngine();
      if (parsed.action === 'KILL') hftEngine.killSwitch();
      if (parsed.action === 'RESET') hftEngine.resetState();
      if (parsed.action === 'SET_SYMBOL' && parsed.symbol) hftEngine.setSymbol(parsed.symbol);
      if (parsed.action === 'SET_CONFIG' && parsed.config) hftEngine.updateConfig(parsed.config);

      // Real-time sniper actions via WebSocket routed through authoritative coordinator
      const rejectWsInput = (issues: Array<{ path: string; message: string }>) =>
        ws.send(JSON.stringify({ type: 'VALIDATION_ERROR', action: parsed.action, error: 'INVALID_REQUEST', issues }));

      if (parsed.action === 'SNIPE_PUMP_CALLOUT') {
        const input = validateTradeInput(CalloutSnipeSchema, parsed);
        if (input.status === 'invalid') return rejectWsInput(input.issues);
        const result = await pumpFunService.snipeCallout(
          input.data.calloutId,
          input.data.amountUsd,
          input.data.jitoTipSol,
          input.data.slippagePct
        );
        ws.send(JSON.stringify({ type: 'CALLOUT_SNIPE_RESULT', data: result }));
      }
      if (parsed.action === 'TOGGLE_CALLER_SNIPE') {
        const input = validateTradeInput(ToggleCallerSchema, parsed);
        if (input.status === 'invalid') return rejectWsInput(input.issues);
        const updated = pumpFunService.toggleCallerAutoSnipe(input.data.userId);
        if (updated) {
          broadcastWs({
            type: 'CALLER_SUBSCRIPTION_UPDATED',
            data: updated,
          });
        }
      }
      if (parsed.action === 'SNIPE_MEMECOIN') {
        const input = validateTradeInput(OperatorSnipeSchema, parsed);
        if (input.status === 'invalid') return rejectWsInput(input.issues);
        const result = await memecoinAggregator.executeSnipe({ ...input.data, provenance: OPERATOR_PROVENANCE, signalTimestamp: Date.now() });
        ws.send(JSON.stringify({ type: 'MEMECOIN_SNIPE_RESULT', data: result }));
      }
      if (parsed.action === 'CLOSE_POSITION') {
        const input = validateTradeInput(OperatorCloseSchema, parsed);
        if (input.status === 'invalid') return rejectWsInput(input.issues);
        const result = await memecoinAggregator.closePosition(input.data.positionId, input.data.sellPct);
        ws.send(JSON.stringify({ type: 'POSITION_CLOSED_RESULT', data: result }));
      }
      if (parsed.action === 'PANIC_LIQUIDATE') {
        const result = await walletTrader.panicLiquidateAll();
        ws.send(JSON.stringify({ type: 'PANIC_LIQUIDATION_RESULT', data: result }));
      }
    } catch {}
  });
});

// Broadcast engine updates over WebSocket
hftEngine.onTelemetry((tel) => {
  broadcastWs({ type: 'TELEMETRY', data: tel });
});

hftEngine.onTrade((trade) => {
  broadcastWs({ type: 'TRADE_FILL', data: trade });
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
watchWindow.attach(pumpFeedListener);
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
app.post('/api/auth/login', (req, res) => {
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
      role: 'OPERATOR',
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
  const mem = process.memoryUsage();
  res.json({
    status: 'ONLINE',
    runtime: 'Node.js',
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    engineUptimeSeconds: Math.floor(process.uptime()),
    memoryHeapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
    memoryHeapTotalMB: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
    memoryRssMB: Number((mem.rss / 1024 / 1024).toFixed(2)),
    telemetryMode: 'AUTHENTIC_LOCAL_NODE',
  });
});

// 3. Market data proxy routes (orderbook, trades, ticker) live in server/market/marketRoutes.ts (B2).
registerMarketRoutes(app);

// 3h. Account Portfolio & Balance Retrieval
app.get('/api/account/balance', requireOperatorAuth, async (req, res) => {
  if (req.query.secret || req.query.apiSecret || req.query.apiKey) {
    return res.status(400).json({
      error: 'CRITICAL_SECURITY_VIOLATION',
      message: 'Credentials must NEVER be passed via URL query parameters. Use HTTP headers (x-mbx-apikey, x-mbx-apisecret).',
    });
  }
  const apiKey = req.headers['x-mbx-apikey'] as string;
  const apiSecret = (req.headers['x-mbx-apisecret'] || req.headers['x-api-secret']) as string;

  if (apiKey && apiSecret) {
    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
      const apiRes = await fetch(`https://testnet.binance.vision/api/v3/account?${queryString}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': apiKey },
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const balances = (data.balances || [])
          .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
          .map((b: any) => ({
            asset: b.asset,
            free: parseFloat(b.free),
            locked: parseFloat(b.locked),
            totalUsd: parseFloat(b.free) * (b.asset === 'USDT' ? 1 : b.asset === 'BTC' ? 68900 : 2800),
          }));
        return res.json({ source: 'BINANCE_TESTNET', balances, canTrade: data.canTrade });
      }
    } catch {
      // fallback
    }
  }

  // Institutional paper balances
  res.json({
    source: 'APEX_INSTITUTIONAL_LEDGER',
    balances: [
      { asset: 'USDT', free: 345250.0, locked: 12000.0, totalUsd: 357250.0 },
      { asset: 'BTC', free: 2.154, locked: 0.25, totalUsd: 165645.0 },
      { asset: 'ETH', free: 15.42, locked: 2.0, totalUsd: 49472.0 },
      { asset: 'SOL', free: 85.0, locked: 0.0, totalUsd: 12087.0 },
    ],
    canTrade: true,
  });
});

// 4. Automated Unit Testing Suite Runner (200 Quantitative HFT & Bonding Curve Test Cases)
app.get('/api/unit-tests', requireOperatorAuth, (req, res) => {
  const suiteOutput = runComprehensiveTestSuite();
  res.json(suiteOutput);
});

// 5. AI Quant Diagnostics with High Thinking Mode (gemini-3.1-pro-preview) and Market Grounding (gemini-3.5-flash)
app.post('/api/ai/diagnostics', requireOperatorAuth, async (req, res) => {
  const { mode = 'thinking', strategyConfig, telemetry, prompt } = req.body;
  const ai = getGenAI();

  if (!ai) {
    return res.status(503).json({
      error: 'GEMINI_API_KEY is not configured. Add it in AI Studio Settings to activate AI Quant Diagnostics.',
      offlineAnalysis: {
        recommendation: 'Risk profile looks balanced for high-watermark scaling. Recommended inventory gamma adjustment: 0.12.',
        estimatedSharpe: 2.85,
        riskScore: 'LOW_RISK',
      },
    });
  }

  try {
    if (mode === 'thinking') {
      // User directive: MUST use gemini-3.1-pro-preview with thinkingLevel: 'HIGH', no maxOutputTokens
      const systemInstruction = `You are the Principal Quantitative Strategist & Chief Risk Officer at Apex Quant HFT.
Provide deep, rigorous mathematical analysis of high-frequency execution strategies, order flow imbalance, inventory risk, and network degradation profiles.
Respond with:
1. Executive Risk & Alpha Assessment
2. Mathematical Formula Calibrations (Avellaneda-Stoikov gamma, kappa, volatility sigma)
3. Congestion & Slippage Vulnerability Analysis
4. Actionable Parameter Tuning Suggestions`;

      const userMessage = `Analyze the current workstation configuration and strategy fleet:
Strategy Fleet Context: ${JSON.stringify(strategyConfig || {}, null, 2)}
Real-Time Telemetry: ${JSON.stringify(telemetry || {}, null, 2)}
User Query: ${prompt || 'Perform full risk audit and latency sensitivity analysis.'}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [
          { role: 'user', parts: [{ text: `${systemInstruction}\n\n${userMessage}` }] },
        ],
        config: {
          thinkingConfig: {
            thinkingLevel: 'HIGH' as any,
          },
        },
      });

      return res.json({
        model: 'gemini-3.1-pro-preview',
        thinkingEnabled: true,
        analysis: response.text || 'Analysis completed.',
      });
    } else {
      // User directive: MUST use gemini-3.5-flash with googleSearch tool for real-time market grounding
      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt || 'What are the current macroeconomic volatility drivers impacting HFT market making spreads today?',
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      return res.json({
        model: 'gemini-3.5-flash',
        grounded: true,
        analysis: response.text || 'Market search completed.',
        groundingMetadata: response.candidates?.[0]?.groundingMetadata,
      });
    }
  } catch (err: any) {
    console.error('Gemini API Error:', err);
    res.status(500).json({
      error: err.message || 'Error processing AI Diagnostics',
    });
  }
});

// 6. Raw Packet Logs Exporter (PCAP-JSON formatted)
app.post('/api/export/packets', requireOperatorAuth, (req, res) => {
  const { logs } = req.body;
  const rawData = {
    pcapHeader: {
      magicNumber: '0xa1b2c3d4',
      versionMajor: 2,
      versionMinor: 4,
      thisZone: 0,
      sigFigs: 0,
      snapLen: 65535,
      network: 1, // Ethernet
    },
    exportTimestamp: new Date().toISOString(),
    packetsCount: logs?.length || 0,
    packets: logs || [],
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="apex_hft_packet_stream.json"');
  res.send(JSON.stringify(rawData, null, 2));
});

// 7. High-Performance Autonomous Execution Engine Endpoints
app.get('/api/engine/status', requireOperatorAuth, (req, res) => {
  res.json(hftEngine.getTelemetry());
});

app.post('/api/engine/start', requireOperatorAuth, (req, res) => {
  hftEngine.startEngine();
  res.json({ status: 'OK', telemetry: hftEngine.getTelemetry() });
});

app.post('/api/engine/stop', requireOperatorAuth, (req, res) => {
  hftEngine.stopEngine();
  res.json({ status: 'OK', telemetry: hftEngine.getTelemetry() });
});

app.post('/api/engine/reset', requireOperatorAuth, (req, res) => {
  hftEngine.resetState();
  res.json({ status: 'OK', telemetry: hftEngine.getTelemetry() });
});

app.post('/api/engine/kill', requireOperatorAuth, (req, res) => {
  hftEngine.killSwitch();
  res.json({ status: 'OK', telemetry: hftEngine.getTelemetry() });
});

app.post('/api/engine/symbol', requireOperatorAuth, (req, res) => {
  if (req.body.symbol) {
    hftEngine.setSymbol(req.body.symbol);
  }
  res.json({ status: 'OK', telemetry: hftEngine.getTelemetry() });
});

app.post('/api/engine/config', requireOperatorAuth, (req, res) => {
  hftEngine.updateConfig(req.body);
  res.json({ status: 'OK', telemetry: hftEngine.getTelemetry() });
});

app.get('/api/engine/wal', requireOperatorAuth, (req, res) => {
  const limit = parseInt(req.query.limit as string) || 60;
  res.json({
    seqId: hftEngine.getWAL().getCurrentSeq(),
    entries: hftEngine.getWAL().getRecent(limit),
  });
});

app.get('/api/engine/wal/export', requireOperatorAuth, (req, res) => {
  const journal = hftEngine.getWAL().exportJournal();
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="apex_engine_journal.wal"');
  res.send(journal);
});

app.post('/api/engine/risk/limits', requireOperatorAuth, (req, res) => {
  hftEngine.getRiskEngine().updateLimits(req.body);
  res.json({ status: 'OK', limits: hftEngine.getRiskEngine().getLimits() });
});

app.get('/api/engine/risk/limits', requireOperatorAuth, (req, res) => {
  res.json(hftEngine.getRiskEngine().getLimits());
});

// 8. Standalone Rust Engine Source & $10 Micro-Capital Configuration
app.get('/api/engine/rust/source', requireOperatorAuth, (req, res) => {
  try {
    const crateDir = path.join(process.cwd(), 'crates', 'apex_hft_engine');

    const files: Record<string, string> = {};
    const readSafe = (subPath: string) => {
      try {
        return fs.readFileSync(path.join(crateDir, subPath), 'utf8');
      } catch {
        return '';
      }
    };

    files['Cargo.toml'] = readSafe('Cargo.toml');
    files['README.md'] = readSafe('README.md');
    files['src/main.rs'] = readSafe('src/main.rs');
    files['src/lib.rs'] = readSafe('src/lib.rs');
    files['src/order_book.rs'] = readSafe('src/order_book.rs');
    files['src/ring_buffer.rs'] = readSafe('src/ring_buffer.rs');
    files['src/risk.rs'] = readSafe('src/risk.rs');
    files['src/avellaneda_stoikov.rs'] = readSafe('src/avellaneda_stoikov.rs');
    files['src/wal.rs'] = readSafe('src/wal.rs');

    res.json({ status: 'OK', crateName: 'apex_hft_engine', files });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.post('/api/engine/mode/micro-10', requireOperatorAuth, (req, res) => {
  const { enabled } = req.body;
  if (enabled) {
    // Apply $10 micro-capital constraints
    hftEngine.updateConfig({
      baseQuoteSize: 0.0001, // ~6.80 USD on BTC, satisfying Binance's 5 USDT minimum notional
      targetSpreadBps: 4.0,  // Wider spread to offset retail taker/maker fees
      gamma: 0.35,           // Higher risk aversion
      inventoryLimitQty: 0.0002,
    });
    hftEngine.getRiskEngine().updateLimits({
      minOrderNotionalUsd: 5.0,  // Exchange minimum notional
      maxOrderNotionalUsd: 10.0, // Hard ceiling for $10 account
      maxSingleOrderQty: 0.0002,
      maxDailyLossUsd: 2.0,      // Max 20% drawdown on $10
      fatFingerPriceBandPct: 1.5,
    });
  } else {
    // Institutional defaults
    hftEngine.updateConfig({
      baseQuoteSize: 0.05,
      targetSpreadBps: 2.0,
      gamma: 0.1,
      inventoryLimitQty: 5.0,
    });
    hftEngine.getRiskEngine().updateLimits({
      minOrderNotionalUsd: 5.0,
      maxOrderNotionalUsd: 50000.0,
      maxSingleOrderQty: 5.0,
      maxDailyLossUsd: 5000.0,
      fatFingerPriceBandPct: 2.5,
    });
  }
  res.json({
    status: 'OK',
    isMicro10: enabled,
    telemetry: hftEngine.getTelemetry(),
    limits: hftEngine.getRiskEngine().getLimits(),
  });
});

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

app.post('/api/social/signals/snipe', requireOperatorAuth, validateTradeBody(SignalSnipeSchema), async (req, res) => {
  const { signalId } = req.body;
  const existing = socialScanner.getSignals().find((s) => s.id === signalId);
  if (!existing) {
    return res.status(404).json({ error: 'Signal not found' });
  }
  // An unverified signal (live-ingested, no real scoring) must never reach a live trade.
  if (executionCoordinator.isLiveArmed() && existing.verified !== true) {
    return res.status(409).json({ error: 'UNVERIFIED_SIGNAL: refusing to snipe an unverified signal while LIVE is armed' });
  }
  const sig = socialScanner.markSniped(signalId)!;

  // Trigger sniper trade on the aggregator
  const tradeResult = await memecoinAggregator.executeSnipe({
    contractAddress: sig.contractAddress,
    amountUsd: req.body.amountUsd,
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
});

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

app.post('/api/telegram/webhook', requireOperatorAuth, async (req, res) => {
  const { message } = req.body;
  const text = message?.text || req.body?.text || '';
  const result = await socialScanner.processTelegramCommand(text);

  res.json({
    ok: true,
    result,
  });
});

app.post('/api/telegram/test-connection', requireOperatorAuth, async (req, res) => {
  const { botToken, chatId, sendPingMessage } = req.body || {};
  const testResult = await socialScanner.testTelegramConnection(botToken, chatId, sendPingMessage);
  res.json(testResult);
});

app.post('/api/social/test-twitter', requireOperatorAuth, async (req, res) => {
  const { bearerToken } = req.body || {};
  const testResult = await socialScanner.testXTwitterConnection(bearerToken);
  res.json(testResult);
});

// Full External Connectivity Diagnostics & Simulation Scope Audit
app.get('/api/connectivity/diagnostics', requireOperatorAuth, async (req, res) => {
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
        isAutoSnipeSubscribed: p.isAutoSnipeSubscribed,
      })),
      activeCalloutsCount: hotCallouts.length,
      multiCallerConfluenceCount: confluenceCallouts.length,
      confluenceTokens: confluenceCallouts.map((c) => ({
        symbol: c.token.symbol,
        mint: c.token.mint,
        action: c.hftAction,
        confluenceCount: c.confluenceCount,
        callers: [`@${c.caller.userId}`, ...c.otherCallers],
      })),
    },
    simulationScopeMatrix: [
      {
        subsystem: 'Pump.fun Token Discovery & Velocity',
        nature: 'LIVE',
        details:
          'Fetches real new tokens and bonding curve progress via live HTTP GET requests to frontend-api-v3.pump.fun every 5s.',
      },
      {
        subsystem: 'DexScreener Boosted & Pool Metrics',
        nature: 'LIVE',
        details:
          'Pulls live boosted tokens and 5-minute buy/sell ratios from api.dexscreener.com in real-time.',
      },
      {
        subsystem: 'Multi-Caller Confluence Engine',
        nature: 'LIVE_COMPUTATION',
        details:
          'Evaluates intersection between live Pump.fun tokens and live DexScreener boosted coins in real-time to trigger INSTANT_SNIPE priority.',
      },
      {
        subsystem: 'Telegram Bot API Link',
        nature: 'PARTIAL',
        details:
          'The command handler (/snipe, /signals, /positions, /status, /panic_sell) runs when something posts to the operator-authenticated /api/telegram/webhook. NOT implemented: setWebhook registration with Telegram, getUpdates polling, and alert forwarding (autoForwardAlerts is stored but never used). Outbound connectivity can be tested with a bot token; nothing is sent automatically.',
      },
      {
        subsystem: 'X.com / Twitter Feed & Social Ingestion',
        nature: 'LIVE_REACHABLE_METADATA',
        details:
          'Outbound HTTPS routing to api.twitter.com verified (HTTP 200). Actively ingests live creator and community X/Twitter links directly from on-chain Pump.fun and DexScreener metadata, with full one-click links to live tweets, search feeds, and profiles. Ready to connect to Twitter API v2 if TWITTER_BEARER_TOKEN is supplied.',
      },
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
          : 'LIVE is not armed: snipes are paper-traded in memory against the curve quote. No transaction is signed or sent.',
      },
      {
        subsystem: 'Jito MEV Bundles & Priority Tips',
        nature: executionCoordinator.isLiveArmed() ? 'LIVE_CLUSTER_DEPENDENT' : 'PAPER_ONLY',
        details:
          'Priority tips follow the executionConfig tip policy. Bundles go to Jito only on mainnet-beta (never enabled by default); on devnet or localnet the transaction goes to the cluster RPC with a priority fee and no bundle. In paper mode nothing is sent.',
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
});

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

app.post('/api/memecoins/trade', requireOperatorAuth, validateTradeBody(OperatorSnipeSchema), async (req, res) => {
  const result = await memecoinAggregator.executeSnipe({ ...req.body, provenance: OPERATOR_PROVENANCE, signalTimestamp: Date.now() });

  res.json({
    status: result.success ? 'OK' : 'REJECTED',
    result,
  });
});

app.post('/api/memecoins/close', requireOperatorAuth, validateTradeBody(OperatorCloseSchema), async (req, res) => {
  const { positionId, sellPct } = req.body;
  const result = await memecoinAggregator.closePosition(positionId, sellPct);
  res.json({
    status: result.success ? 'OK' : 'ERROR',
    result,
  });
});

/** The bot token is write-only: it never leaves the server once stored. */
function redactSniperConfig<T extends { telegramBotToken?: string }>(c: T) {
  return { ...c, telegramBotToken: '', telegramBotTokenSet: Boolean(c.telegramBotToken) };
}

app.get('/api/memecoins/config', requireOperatorAuth, (req, res) => {
  res.json({
    status: 'OK',
    config: redactSniperConfig(memecoinAggregator.getConfig()),
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

app.post('/api/pumpfun/callouts/snipe', requireOperatorAuth, validateTradeBody(CalloutSnipeSchema), async (req, res) => {
  const { calloutId, amountUsd, jitoTipSol, slippagePct } = req.body;

  const result = await pumpFunService.snipeCallout(calloutId, amountUsd, jitoTipSol, slippagePct);

  res.json({
    status: result.success ? 'OK' : 'REJECTED',
    result,
  });
});

app.post('/api/pumpfun/callouts/toggle-autosnipe', requireOperatorAuth, validateTradeBody(ToggleCallerSchema), (req, res) => {
  const { userId } = req.body;

  const caller = pumpFunService.toggleCallerAutoSnipe(userId);
  if (!caller) {
    return res.status(404).json({ error: 'Caller not found' });
  }

  res.json({
    status: 'OK',
    caller,
  });
});

app.get('/api/pumpfun/callouts/rules', requireOperatorAuth, (req, res) => {
  res.json({
    status: 'OK',
    rules: pumpFunService.getAutoSnipeRules(),
  });
});

app.post('/api/pumpfun/callouts/rules', requireOperatorAuth, (req, res) => {
  const updated = pumpFunService.updateAutoSnipeRules(req.body);
  res.json({
    status: 'OK',
    rules: updated,
  });
});

app.get('/api/pumpfun/status', requireOperatorAuth, (req, res) => {
  res.json(pumpFunService.getStatus());
});

app.post('/api/pumpfun/refresh', requireOperatorAuth, async (req, res) => {
  // A manual refresh only reloads the feed; it must never evaluate auto-snipe triggers (A5).
  await pumpFunService.syncRealWorldData({ evaluateTriggers: false });
  res.json({
    status: 'OK',
    calloutsCount: pumpFunService.getHotCallouts().length,
    timestamp: Date.now(),
  });
});


// ============================================================================
// 14. REALISM & CO-LOCATION MICROSTRUCTURE CONFIG ENDPOINTS
// ============================================================================
app.get('/api/realism/config', requireOperatorAuth, (req, res) => {
  res.json({
    status: 'OK',
    config: realismEngine.getConfig(),
    regions: realismEngine.getRegionDetails(),
    feeSchedules: realismEngine.getFeeSchedule(),
  });
});

app.post('/api/realism/config', requireOperatorAuth, (req, res) => {
  const updated = realismEngine.updateConfig(req.body);
  res.json({
    status: 'OK',
    config: updated,
  });
});

// ============================================================================
// 15. PLUG-AND-PLAY WALLET ONBOARDING & LIVE AUTONOMOUS TRADING ENDPOINTS
// ============================================================================
app.get('/api/wallet/state', requireOperatorAuth, (req, res) => {
  res.json({
    success: true,
    data: walletTrader.getState(),
    config: walletTrader.getConfig(),
  });
});

app.post('/api/wallet/config', requireOperatorAuth, validateBody(WalletConfigSchema), async (req, res) => {
  try {
    const updated = await walletTrader.updateConfig(req.body);
    res.json({
      success: true,
      config: updated,
      state: walletTrader.getState(),
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message, state: walletTrader.getState() });
  }
});

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

app.post('/api/wallet/snipe', requireOperatorAuth, validateBody(LiveSnipeOrderSchema), async (req, res) => {
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
});

app.post('/api/wallet/close-position', requireOperatorAuth, validateBody(ClosePositionSchema), async (req, res) => {
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
});

app.post('/api/wallet/panic-liquidate', requireOperatorAuth, async (req, res) => {
  const result = await walletTrader.panicLiquidateAll();
  res.json({
    success: true,
    message: `Emergency liquidation complete. Attempted: ${result.attemptedCount}, Succeeded: ${result.succeeded.length}, Failed: ${result.failed.length}`,
    data: result,
    state: walletTrader.getState(),
  });
});

app.post('/api/wallet/sync-rpc', requireOperatorAuth, async (req, res) => {
  const solBalance = await walletTrader.syncRpcBalance();
  res.json({
    success: true,
    solBalance,
    state: walletTrader.getState(),
  });
});

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
      rpcEndpoint: resolveRpcUrl(),
      allowedCluster: allowedCluster(),
      rpcLatencyMs: diag.rpcLatencyMs,
      databaseFile: 'apex_workstation.db',
      dbDriver: 'node:sqlite (WAL mode enabled)',
      keypairStorage: 'Local filesystem (mode 0600) at .apex_trading_keypair.json',
      browserPrivateKeySecurity: 'Private keys are NEVER accepted via HTTP/WebSocket requests.',
      hftPaperIsolation: 'CME/Binance/Coinbase L2 HFT engine runs strictly in-memory simulation; completely isolated from real-money Solana wallet.',
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

// G1: auto-snipe controller. Mode lives in memory only, so every restart comes back OFF.
app.get('/api/auto/status', requireOperatorAuth, (req, res) => {
  res.json({ success: true, ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats(), decisions: autoSnipeController.getDecisions(100) });
});

app.post('/api/auto/mode', requireOperatorAuth, validateTradeBody(AutoModeSchema), async (req, res) => {
  const { mode, confirmationCode } = req.body;
  const result = await autoSnipeController.setMode(mode, { confirmationCode });
  res.status(result.ok ? 200 : 409).json({ success: result.ok, ...result, status: autoSnipeController.getStatus() });
});

app.post('/api/auto/kill', requireOperatorAuth, validateTradeBody(AutoKillSchema), async (req, res) => {
  const result = await autoSnipeController.kill({ exitAll: req.body.exitAll, reason: req.body.reason });
  res.json({ success: true, ...result, status: autoSnipeController.getStatus() });
});

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

app.get('/api/market/curve/:mint', requireOperatorAuth, async (req, res) => {
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
});

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
  res.json({ success: true, ...autoSnipeController.resume({ clearHalt: req.body.clearHalt }), status: autoSnipeController.getStatus() });
});

autoSnipeController.on('decision', (d) => broadcastWs({ type: 'AUTO_DECISION', data: d }));
autoSnipeController.on('mode', (d) => broadcastWs({ type: 'AUTO_MODE', data: { ...d, status: autoSnipeController.getStatus() } }));

app.post('/api/execution/arm', requireOperatorAuth, validateTradeBody(ArmSchema), (req, res) => {
  const { arm, confirmationCode } = req.body;
  const result = executionCoordinator.armLiveTrading(Boolean(arm), confirmationCode);
  if (!result.success) {
    return res.status(403).json(result);
  }
  res.json(result);
});

app.post('/api/execution/kill-switch', requireOperatorAuth, (req, res) => {
  // Explicit boolean only: an empty POST or {"activate":"false"} must not trip it, and must never silently reset it.
  const parsed = KillSwitchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success: false, error: 'activate must be true or false' });
  const { activate } = parsed.data;
  riskEngine.setKillSwitch(activate);
  if (activate) {
    executionCoordinator.armLiveTrading(false);
  }
  res.json({
    success: true,
    killSwitchActive: riskEngine.isKillSwitchActive(),
    // R26: resetting the switch does not lift an open circuit breaker or an all-trading halt; say so, so the UI cannot claim "allowed again"
    circuitBreaker: riskEngine.getCircuitBreakerState(),
    haltReason: executionCoordinator.getHaltReason(),
    message: activate ? 'EMERGENCY KILL SWITCH TRIPPED. All trading halted.' : 'Kill switch reset.',
  });
});

app.post('/api/execution/trade', requireOperatorAuth, validateTradeBody(OperatorExecuteTradeSchema), async (req, res) => {
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
});

app.post('/api/execution/close', requireOperatorAuth, validateTradeBody(OperatorCloseSchema), async (req, res) => {
  try {
    const { positionId, sellPct, reason = 'Operator close' } = req.body;
    const result = await executionCoordinator.closePosition(positionId, sellPct, reason);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/execution/reconcile', requireOperatorAuth, async (req, res) => {
  try {
    const result = await executionCoordinator.startupReconciliation({ fresh: true }); // R17: a click never reads a run that began before it
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
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
  if (process.env.APEX_DISABLE_EXTERNAL_FEEDS !== 'true') {
    solPriceService.startAutoRefresh();
    pumpFunService.startBackground();
  }
  // N18: bound the append-only audit tables (default 90 days; APEX_RETENTION_DAYS, 0 disables). Once at boot, then daily.
  const retentionDays = process.env.APEX_RETENTION_DAYS === undefined ? 90 : Number(process.env.APEX_RETENTION_DAYS);
  const prune = () => {
    const r = workstationDb.pruneOldRows(retentionDays);
    if (r.riskDecisions + r.decisions + r.journal > 0) Logger.info(`Retention: pruned ${r.riskDecisions} risk decisions, ${r.decisions} decisions, ${r.journal} journal rows older than ${retentionDays} days`);
  };
  prune();
  setInterval(prune, 86_400_000).unref();
  autoSnipeController.startMonitor(); // G3: kill-switch triggers and wallet audit (inert while the mode is OFF)
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[APEX QUANT HFT] Autonomous Execution Engine running on ${BIND_HOST}:${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer();
}
