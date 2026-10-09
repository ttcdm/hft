import {
  EngineTelemetryData,
  EngineWALEntry,
  PumpFunHotCallout,
  PumpFunCaller,
  MemecoinPool,
  SniperPosition,
  SniperBotConfig,
} from '../types';

let cachedSessionToken: string | null = null;

export function setOperatorSessionToken(token: string) {
  cachedSessionToken = token ? token.trim() : null;
  if (typeof window !== 'undefined') {
    if (token && token.trim()) {
      localStorage.setItem('apex_operator_token', token.trim());
    } else {
      localStorage.removeItem('apex_operator_token');
    }
  }
  try {
    engineClient.authenticate();
  } catch {}
}

export async function getOperatorSessionToken(): Promise<string> {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('apex_operator_token');
    if (stored && stored.trim().length > 0) {
      cachedSessionToken = stored.trim();
      return cachedSessionToken;
    }
  }
  if (cachedSessionToken) return cachedSessionToken;

  return '';
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = await getOperatorSessionToken();
  const headers = new Headers(init?.headers || {});
  if (token) {
    headers.set('x-session-token', token);
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(input, { ...init, headers });

  // A1: a 401 means the stored token is stale or missing. Purge it and ask the operator to re-enter
  // it; the server no longer hands out tokens automatically.
  if (res.status === 401) {
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('apex_operator_token');
        window.dispatchEvent(new CustomEvent('apex:auth-required'));
      }
      cachedSessionToken = null;
    } catch {}
  }
  return res;
}

export type EngineTelemetryCallback = (data: EngineTelemetryData) => void;
export type EngineWalCallback = (entries: EngineWALEntry[]) => void;
export type EngineTradeFillCallback = (trade: any) => void;
export type PumpHotCalloutsCallback = (data: {
  callouts: PumpFunHotCallout[];
  leaderboard: PumpFunCaller[];
  status: any;
}) => void;
export type CalloutSnipedCallback = (data: any) => void;
export type MemecoinSnapshotCallback = (data: {
  pools: MemecoinPool[];
  positions: SniperPosition[];
  config: SniperBotConfig;
}) => void;
export type SniperTradeCallback = (data: any) => void;

class EngineClient {
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private telemetryCallbacks: Set<EngineTelemetryCallback> = new Set();
  private walCallbacks: Set<EngineWalCallback> = new Set();
  private tradeCallbacks: Set<EngineTradeFillCallback> = new Set();
  private pumpCalloutCallbacks: Set<PumpHotCalloutsCallback> = new Set();
  private calloutSnipedCallbacks: Set<CalloutSnipedCallback> = new Set();
  private memecoinSnapshotCallbacks: Set<MemecoinSnapshotCallback> = new Set();
  private sniperTradeCallbacks: Set<SniperTradeCallback> = new Set();
  private pollingInterval: any = null;
  private recentWal: EngineWALEntry[] = [];
  private lastTelemetry: EngineTelemetryData | null = null;
  private lastPumpCalloutsData: { callouts: PumpFunHotCallout[]; leaderboard: PumpFunCaller[]; status: any } | null = null;
  private lastMemecoinSnapshot: { pools: MemecoinPool[]; positions: SniperPosition[]; config: SniperBotConfig } | null = null;

  constructor() {
    this.connectWs();
    this.startPollingFallback();
  }

  private connectWs() {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/ws/engine`;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = async () => {
        this.isConnected = true;
        const token = await getOperatorSessionToken();
        if (token && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'AUTH', action: 'AUTH', token, sessionToken: token }));
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'TELEMETRY' && msg.data) {
            this.lastTelemetry = msg.data;
            this.telemetryCallbacks.forEach((cb) => cb(msg.data));
          } else if (msg.type === 'WAL_SNAPSHOT' && Array.isArray(msg.data)) {
            this.recentWal = msg.data;
            this.walCallbacks.forEach((cb) => cb(msg.data));
          } else if (msg.type === 'TRADE_FILL' && msg.data) {
            this.tradeCallbacks.forEach((cb) => cb(msg.data));
          } else if (msg.type === 'PUMP_HOT_CALLOUTS' && msg.data) {
            this.lastPumpCalloutsData = msg.data;
            this.pumpCalloutCallbacks.forEach((cb) => cb(msg.data));
          } else if (msg.type === 'CALLOUT_SNIPED' && msg.data) {
            this.calloutSnipedCallbacks.forEach((cb) => cb(msg.data));
          } else if (msg.type === 'MEMECOIN_SNAPSHOT' && msg.data) {
            this.lastMemecoinSnapshot = msg.data;
            this.memecoinSnapshotCallbacks.forEach((cb) => cb(msg.data));
          } else if (msg.type === 'MEMECOIN_POSITIONS_SNAPSHOT' && msg.data?.positions) {
            if (this.lastMemecoinSnapshot) {
              this.lastMemecoinSnapshot.positions = msg.data.positions;
            } else {
              this.lastMemecoinSnapshot = {
                pools: [],
                positions: msg.data.positions,
                config: {} as any,
              };
            }
            this.memecoinSnapshotCallbacks.forEach((cb) => cb(this.lastMemecoinSnapshot!));
          } else if (msg.type === 'MEMECOIN_PRICE_UPDATE' && msg.data) {
            if (this.lastMemecoinSnapshot) {
              this.lastMemecoinSnapshot.pools = msg.data.pools;
              this.lastMemecoinSnapshot.positions = msg.data.positions;
            }
            this.memecoinSnapshotCallbacks.forEach((cb) => cb(msg.data));
          } else if (msg.type === 'SNIPER_TRADE' && msg.data) {
            this.sniperTradeCallbacks.forEach((cb) => cb(msg.data));
          }
        } catch {}
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        setTimeout(() => this.connectWs(), 3000);
      };

      this.ws.onerror = () => {
        this.isConnected = false;
      };
    } catch {
      this.isConnected = false;
    }
  }

  public async authenticate() {
    const token = await getOperatorSessionToken();
    if (token && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'AUTH', action: 'AUTH', token, sessionToken: token }));
    }
  }

  private startPollingFallback() {
    this.pollingInterval = setInterval(async () => {
      // Only poll as a fallback if WebSocket is not actively connected
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        return;
      }
      try {
        const res = await authFetch('/api/engine/status');
        if (res.ok) {
          const data: EngineTelemetryData = await res.json();
          this.lastTelemetry = data;
          this.telemetryCallbacks.forEach((cb) => cb(data));
        }

        const walRes = await authFetch('/api/engine/wal?limit=40');
        if (walRes.ok) {
          const walData = await walRes.json();
          if (walData.entries) {
            this.recentWal = walData.entries;
            this.walCallbacks.forEach((cb) => cb(walData.entries));
          }
        }
      } catch {}
    }, 1500);
  }

  public onTelemetry(cb: EngineTelemetryCallback) {
    this.telemetryCallbacks.add(cb);
    if (this.lastTelemetry) cb(this.lastTelemetry);
    return () => this.telemetryCallbacks.delete(cb);
  }

  public onWal(cb: EngineWalCallback) {
    this.walCallbacks.add(cb);
    if (this.recentWal.length > 0) cb(this.recentWal);
    return () => this.walCallbacks.delete(cb);
  }

  public onTrade(cb: EngineTradeFillCallback) {
    this.tradeCallbacks.add(cb);
    return () => this.tradeCallbacks.delete(cb);
  }

  public onPumpHotCallouts(cb: PumpHotCalloutsCallback) {
    this.pumpCalloutCallbacks.add(cb);
    if (this.lastPumpCalloutsData) cb(this.lastPumpCalloutsData);
    return () => this.pumpCalloutCallbacks.delete(cb);
  }

  public onCalloutSniped(cb: CalloutSnipedCallback) {
    this.calloutSnipedCallbacks.add(cb);
    return () => this.calloutSnipedCallbacks.delete(cb);
  }

  public onMemecoinSnapshot(cb: MemecoinSnapshotCallback) {
    this.memecoinSnapshotCallbacks.add(cb);
    if (this.lastMemecoinSnapshot) cb(this.lastMemecoinSnapshot);
    return () => this.memecoinSnapshotCallbacks.delete(cb);
  }

  public onSniperTrade(cb: SniperTradeCallback) {
    this.sniperTradeCallbacks.add(cb);
    return () => this.sniperTradeCallbacks.delete(cb);
  }

  public isWsConnected(): boolean {
    return this.isConnected;
  }

  public wsSnipePumpCallout(calloutId: string, amountUsd: number = 5.0, jitoTipSol: number = 0.005, slippagePct: number = 6.0) {
    this.sendAction('SNIPE_PUMP_CALLOUT', { calloutId, amountUsd, jitoTipSol, slippagePct });
  }

  public wsToggleCallerSubscription(userId: string) {
    this.sendAction('TOGGLE_CALLER_SNIPE', { userId });
  }

  public wsSnipeMemecoin(params: { contractAddress: string; amountUsd: number; jitoTipSol?: number; slippagePct?: number }) {
    this.sendAction('SNIPE_MEMECOIN', params);
  }

  public wsClosePosition(positionId: string, sellPct: number = 100) {
    this.sendAction('CLOSE_POSITION', { positionId, sellPct });
  }

  public sendAction(action: string, payload: Record<string, any> = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action, ...payload }));
    } else {
      // REST fallback
      const endpointMap: Record<string, string> = {
        START: '/api/engine/start',
        STOP: '/api/engine/stop',
        RESET: '/api/engine/reset',
        KILL: '/api/engine/kill',
        SET_SYMBOL: '/api/engine/symbol',
        SET_CONFIG: '/api/engine/config',
      };

      const url = endpointMap[action];
      if (url) {
        authFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    }
  }

  public start() {
    this.sendAction('START');
  }

  public stop() {
    this.sendAction('STOP');
  }

  public reset() {
    this.sendAction('RESET');
  }

  public kill() {
    this.sendAction('KILL');
  }

  public setSymbol(symbol: string) {
    this.sendAction('SET_SYMBOL', { symbol });
  }

  public updateConfig(config: any) {
    this.sendAction('SET_CONFIG', { config });
  }

  public async updateRiskLimits(limits: any) {
    try {
      const res = await authFetch('/api/engine/risk/limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(limits),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
    }
  }

  public async setMicro10Mode(enabled: boolean) {
    try {
      const res = await authFetch('/api/engine/mode/micro-10', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
    }
  }

  public async fetchRustSource() {
    try {
      const res = await authFetch('/api/engine/rust/source');
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  public downloadWalJournal() {
    window.location.href = '/api/engine/wal/export';
  }

  // ---------------- SOCIAL SCANNER & TELEGRAM ALPHA ----------------
  public async getSocialSignals() {
    try {
      const res = await authFetch('/api/social/signals');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return { status: 'ERROR', signals: [] };
  }

  public async snipeSocialSignal(signalId: string, amountUsd: number = 5.0, jitoTipSol: number = 0.005, slippagePct: number = 8.0) {
    try {
      const res = await authFetch('/api/social/signals/snipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signalId, amountUsd, jitoTipSol, slippagePct }),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
      return { status: 'ERROR', message: 'Failed to snipe signal' };
    }
  }

  public async getTelegramConfig() {
    try {
      const res = await authFetch('/api/telegram/config');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  public async updateTelegramConfig(cfg: any) {
    try {
      const res = await authFetch('/api/telegram/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
    }
  }

  public async sendTelegramWebhookMessage(text: string) {
    try {
      const res = await authFetch('/api/telegram/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { text } }),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
      return { ok: false, error: 'Failed to send message' };
    }
  }

  // ---------------- MULTI-PLATFORM MEMECOIN AGGREGATOR ----------------
  public async getMemecoinPools(platform?: string, chain?: string) {
    try {
      const params = new URLSearchParams();
      if (platform && platform !== 'ALL') params.append('platform', platform);
      if (chain && chain !== 'ALL') params.append('chain', chain);
      const res = await authFetch(`/api/memecoins/pools?${params.toString()}`);
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return { status: 'ERROR', pools: [] };
  }

  public async getSniperPositions() {
    try {
      const res = await authFetch('/api/memecoins/positions');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return { status: 'ERROR', positions: [] };
  }

  public async executeMemecoinSnipe(params: {
    contractAddress: string;
    amountUsd: number;
    platform?: string;
    jitoTipSol?: number;
    slippagePct?: number;
    signalId?: string;
  }) {
    try {
      const res = await authFetch('/api/memecoins/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
      return { status: 'ERROR', result: { success: false, message: 'Network error executing trade' } };
    }
  }

  public async closeSniperPosition(positionId: string, sellPct: number = 100) {
    try {
      const res = await authFetch('/api/memecoins/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId, sellPct }),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
      return { status: 'ERROR', result: { success: false, message: 'Failed to close position' } };
    }
  }

  public async getSniperConfig() {
    try {
      const res = await authFetch('/api/memecoins/config');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  public async updateSniperConfig(cfg: any) {
    try {
      const res = await authFetch('/api/memecoins/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
    }
  }

  // ---------------- MICROSTRUCTURE REALISM ----------------
  public async getRealismConfig() {
    try {
      const res = await authFetch('/api/realism/config');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  public async updateRealismConfig(cfg: any) {
    try {
      const res = await authFetch('/api/realism/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
    }
  }

  // ---------------- PUMP.FUN HOT CALLOUTS & LEADERBOARD ----------------
  public async getPumpFunCallouts() {
    try {
      const res = await authFetch('/api/pumpfun/callouts');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  public async getPumpFunLeaderboard() {
    try {
      const res = await authFetch('/api/pumpfun/leaderboard');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  public async snipePumpFunCallout(calloutId: string, amountUsd?: number, jitoTipSol?: number, slippagePct?: number) {
    try {
      const res = await authFetch('/api/pumpfun/callouts/snipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calloutId, amountUsd, jitoTipSol, slippagePct }),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
      return { status: 'ERROR', result: { success: false, message: 'Network error executing snipe' } };
    }
  }

  public async togglePumpFunAutoSnipe(userId: string) {
    try {
      const res = await authFetch('/api/pumpfun/callouts/toggle-autosnipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
    }
  }

  public async getPumpFunRules() {
    try {
      const res = await authFetch('/api/pumpfun/callouts/rules');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  public async updatePumpFunRules(rules: any) {
    try {
      const res = await authFetch('/api/pumpfun/callouts/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rules),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
    }
  }

  public async refreshPumpFunData() {
    try {
      const res = await authFetch('/api/pumpfun/refresh', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  public async getPumpFunStatus() {
    try {
      const res = await authFetch('/api/pumpfun/status');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  public async testTelegramConnection(botToken?: string, chatId?: string, sendPingMessage?: boolean) {
    try {
      const res = await authFetch('/api/telegram/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, chatId, sendPingMessage }),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return {
      reachable: false,
      httpStatus: null,
      latencyMs: 0,
      botAuthorized: false,
      diagnosis: 'Failed to execute local client request to test endpoint.',
      timestamp: Date.now(),
    };
  }

  public async testXTwitterConnection(bearerToken?: string) {
    try {
      const res = await authFetch('/api/social/test-twitter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bearerToken }),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return {
      reachable: false,
      httpStatus: null,
      latencyMs: 0,
      bearerAuthorized: false,
      diagnosis: 'Failed to execute local client request to X.com test endpoint.',
      timestamp: Date.now(),
    };
  }

  public async getConnectivityDiagnostics() {
    try {
      const res = await authFetch('/api/connectivity/diagnostics');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return null;
  }
}

export const engineClient = new EngineClient();
