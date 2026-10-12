import {
  PumpFunHotCallout,
  PumpFunCaller,
  MemecoinPool,
  SniperPosition,
  SniperBotConfig,
} from '../types';

let cachedSessionToken: string | null = null;

export function setOperatorSessionToken(token: string) {
  cachedSessionToken = token ? token.trim() : null;
  if (cachedSessionToken) authRequired = false;
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

// Q42: after a 401 with no token, every poller would re-send its request and re-open the token prompt every few seconds. Until the
// operator enters a token, authenticated calls answer 401 locally (no network) and the prompt event fires once.
let authRequired = false;

export function isAuthRequired(): boolean {
  return authRequired;
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = await getOperatorSessionToken();
  const urlText = typeof input === 'string' ? input : input instanceof URL ? input.pathname : (input as Request).url;
  if (authRequired && !token && !urlText.includes('/api/auth')) {
    return new Response(JSON.stringify({ error: 'Operator token required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
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
        if (!authRequired) window.dispatchEvent(new CustomEvent('apex:auth-required'));
        authRequired = true;
      }
      cachedSessionToken = null;
    } catch {}
  }
  return res;
}

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
  private pumpCalloutCallbacks: Set<PumpHotCalloutsCallback> = new Set();
  private calloutSnipedCallbacks: Set<CalloutSnipedCallback> = new Set();
  private memecoinSnapshotCallbacks: Set<MemecoinSnapshotCallback> = new Set();
  private sniperTradeCallbacks: Set<SniperTradeCallback> = new Set();
  private actionErrorCallbacks: Set<(m: { action?: string; error: string }) => void> = new Set();
  private lastPumpCalloutsData: { callouts: PumpFunHotCallout[]; leaderboard: PumpFunCaller[]; status: any } | null = null;
  private lastMemecoinSnapshot: { pools: MemecoinPool[]; positions: SniperPosition[]; config: SniperBotConfig } | null = null;

  constructor() {
    this.connectWs();
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
          if (msg.type === 'PUMP_HOT_CALLOUTS' && msg.data) {
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
          } else if (msg.type === 'AUTH_ERROR') {
            // Q36: the server refused a WebSocket command. Say so; a silent drop looks like the click worked.
            const m = { action: msg.action as string | undefined, error: String(msg.error || 'Command refused by the server') };
            this.actionErrorCallbacks.forEach((cb) => cb(m));
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

  public onActionError(cb: (m: { action?: string; error: string }) => void) {
    this.actionErrorCallbacks.add(cb);
    return () => { this.actionErrorCallbacks.delete(cb); };
  }

  public onSniperTrade(cb: SniperTradeCallback) {
    this.sniperTradeCallbacks.add(cb);
    return () => this.sniperTradeCallbacks.delete(cb);
  }

  public isWsConnected(): boolean {
    return this.isConnected;
  }

  public wsSnipePumpCallout(calloutId: string, amountUsd: number = 5.0, jitoTipSol: number = 0.005, slippagePct: number = 6.0, confirmLive = false) {
    this.sendAction('SNIPE_PUMP_CALLOUT', { calloutId, amountUsd, jitoTipSol, slippagePct, ...(confirmLive ? { confirmLive: true } : {}) });
  }

  public wsSnipeMemecoin(params: { contractAddress: string; amountUsd: number; jitoTipSol?: number; slippagePct?: number }, confirmLive = false) {
    this.sendAction('SNIPE_MEMECOIN', { ...params, ...(confirmLive ? { confirmLive: true } : {}) });
  }

  public wsClosePosition(positionId: string, sellPct: number = 100) {
    this.sendAction('CLOSE_POSITION', { positionId, sellPct });
  }

  public sendAction(action: string, payload: Record<string, any> = {}) {
    // Q36: the server checks the operator token on every mutating WebSocket command, so each one carries it. With no token or no
    // open socket the command is not sent, and that is reported instead of being dropped silently.
    const token = cachedSessionToken || (typeof window !== 'undefined' ? localStorage.getItem('apex_operator_token') : null);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && token) {
      this.ws.send(JSON.stringify({ action, ...payload, sessionToken: token.trim() }));
    } else {
      const m = { action, error: 'Not sent: the live connection is down and this command has no REST fallback.' };
      this.actionErrorCallbacks.forEach((cb) => cb(m));
    }
  }

  public async getSocialSignals() {
    try {
      const res = await authFetch('/api/social/signals');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(e);
    }
    return { status: 'ERROR', signals: [] };
  }

  public async snipeSocialSignal(signalId: string, amountSol: number, jitoTipSol: number = 0.005, slippagePct: number = 8.0, confirmLive = false) {
    try {
      const res = await authFetch('/api/social/signals/snipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signalId, amountSol, jitoTipSol, slippagePct, ...(confirmLive ? { confirmLive: true } : {}) }),
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
    /** S181: the operator's chosen size in SOL. The server refuses it with a reason when it is out of bounds. */
    amountSol: number;
    platform?: string;
    jitoTipSol?: number;
    slippagePct?: number;
    signalId?: string;
  }, confirmLive = false) {
    try {
      const res = await authFetch('/api/memecoins/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, ...(confirmLive ? { confirmLive: true } : {}) }),
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

  public async snipePumpFunCallout(calloutId: string, amountSol: number, jitoTipSol?: number, slippagePct?: number, confirmLive = false) {
    try {
      const res = await authFetch('/api/pumpfun/callouts/snipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calloutId, amountSol, jitoTipSol, slippagePct, ...(confirmLive ? { confirmLive: true } : {}) }),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
      return { status: 'ERROR', result: { success: false, message: 'Network error executing snipe' } };
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
