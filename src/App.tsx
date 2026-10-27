import { TradingModeBanner } from './components/TradingModeBanner';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PerformanceKPIs, AlertEvent } from './types';
import { hftAudio } from './utils/audio';

import { Header } from './components/Header';
import { AlertSystem, isAlertExpired } from './components/AlertSystem';
import { announceAuthenticated } from './utils/authEvents';
import { AiDiagnosticsModal } from './components/AiDiagnosticsModal';
import { SystemChecksModal } from './components/SystemChecksModal';
import { ExecutionLatencyModal } from './components/ExecutionLatencyModal';
import { AutoPipelineModal } from './components/AutoPipelineModal';
import { MemecoinSocialSniperModal } from './components/MemecoinSocialSniperModal';
import { BacktestModal } from './components/BacktestModal';
import { PlugAndPlayTradingModal } from './components/PlugAndPlayTradingModal';
import { AuthModal } from './components/AuthModal';
import { engineClient, getOperatorSessionToken, authFetch } from './services/engineClient';
import { TokenBoard } from './components/TokenBoard';
import { CurvePanel } from './components/CurvePanel';
import { AutoPanel } from './components/AutoPanel';
import { usePolled } from './utils/usePolled';
import { readServerAlerts, serverAlertEvents, alertsUnreadableEvent, killSwitchStateAlert, acknowledgeServerAlert } from './utils/operatorAlerts';
import { killSwitchPress } from './utils/killSwitchPress';
import { exitAlerts, type WatchedPosition } from './utils/exitWatch';
import { PanelErrorBoundary } from './components/ErrorBoundaries';


export function makeEmptyKpis(startingEquity: number): PerformanceKPIs {
  return {
    dailyPnL: 0,
    unrealizedPnL: 0,
    totalEquity: startingEquity,
    winRate: 0,
    totalTrades: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    profitFactor: 0,
    maxDrawdownPct: 0,
    var99Pct: 0,
    averageLatencyMs: 0,
    p99LatencyMs: 0,
    systemThroughputOps: 0,
    dailyVolumeUsd: 0,
    peakEquity: startingEquity,
  };
}

export default function App() {
  // Master Kill Switch State
  // R10-2: null until the server has answered (and again when it cannot be read): never a guessed "not engaged"
  const [isHalted, setIsHalted] = useState<boolean | null>(null);
  // R9-1: when the switch was last seen turning on (by this button or the poll), so a double tap does not resume trading.
  const haltedSince = useRef<number | null>(null);
  const [haltedSinceAt, setHaltedSinceAt] = useState<number | null>(null);
  useEffect(() => {
    if (isHalted && haltedSince.current === null) haltedSince.current = Date.now();
    if (!isHalted) haltedSince.current = null;
    setHaltedSinceAt(haltedSince.current);
  }, [isHalted]);
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [activeFeed, setActiveFeed] = useState('CME_AURORA');

  // KPIs & Risk Matrix (Initialized for $10 Micro Account)
  const [kpis] = useState<PerformanceKPIs>(makeEmptyKpis(10));

  // Alerts
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);

  // Modals
  const [isAiDiagnosticsOpen, setIsAiDiagnosticsOpen] = useState(false);
  const [isSystemChecksOpen, setIsSystemChecksOpen] = useState(false);
  const [isAutoPipelineOpen, setIsAutoPipelineOpen] = useState(false);
  const [isMemecoinSniperOpen, setIsMemecoinSniperOpen] = useState(false);
  const [isLatencyOpen, setIsLatencyOpen] = useState(false);
  const [isBacktestModalOpen, setIsBacktestModalOpen] = useState(false);
  const [isPlugAndPlayOpen, setIsPlugAndPlayOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isOperatorAuthenticated, setIsOperatorAuthenticated] = useState(false);

  // Check operator authentication status on startup (B03)
  useEffect(() => {
    const checkAuthStatus = async () => {
      const token = await getOperatorSessionToken();
      if (!token) {
        setIsOperatorAuthenticated(false);
        setIsAuthModalOpen(true);
        return;
      }
      try {
        const res = await fetch('/api/auth/session', {
          headers: {
            'Authorization': `Bearer ${token}`,
            'x-session-token': token,
          },
        });
        if (res.ok) {
          setIsOperatorAuthenticated(true);
        } else {
          setIsOperatorAuthenticated(false);
          setIsAuthModalOpen(true);
        }
      } catch {
        setIsOperatorAuthenticated(false);
        setIsAuthModalOpen(true);
      }
    };
    checkAuthStatus();
  }, []);

  // A1: the server never auto-issues tokens, so a 401 from any call re-opens the token prompt
  useEffect(() => {
    const onAuthRequired = () => {
      setIsOperatorAuthenticated(false);
      setIsAuthModalOpen(true);
    };
    window.addEventListener('apex:auth-required', onAuthRequired);
    return () => window.removeEventListener('apex:auth-required', onAuthRequired);
  }, []);

  const handleAuthenticated = (token: string) => {
    setIsOperatorAuthenticated(true);
    setIsAuthModalOpen(false);
    triggerAlert('INFO', 'OPERATOR AUTHENTICATED', 'Operator session successfully established.');
    engineClient.authenticate();
    announceAuthenticated(); // UI-5: the mode banner, auto panel and board read now, not at their next tick
  };

  // Helper to add an alert
  const triggerAlert = useCallback(
    (level: 'INFO' | 'WARNING' | 'CRITICAL', title: string, message: string) => {
      const newAlert: AlertEvent = {
        id: `alert-${Date.now()}-${Math.random()}`,
        timestamp: Date.now(),
        timeStr: new Date().toLocaleTimeString(),
        level,
        title,
        message,
        acknowledged: false,
      };
      setAlerts((prev) => [newAlert, ...prev.slice(0, 15)]);
      hftAudio.playAlertBeep(level === 'CRITICAL' ? 'CRITICAL' : 'WARNING');
    },
    []
  );

  // UI-2: INFO and WARNING alerts expire on their own so the stack does not sit on the Plug & Play footer; CRITICAL stays.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setAlerts((prev) => (prev.some((a) => isAlertExpired(a, now)) ? prev.filter((a) => !isAlertExpired(a, now)) : prev));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // R6-1: the server's operator alerts (exit failing, position gone, halt not saved, ...) join the stack. A CRITICAL one stays until the
  // server clears it; a WARNING or INFO one can be hidden in this browser.
  const checksPoll = usePolled<any>('/api/system/checks', 5000, isOperatorAuthenticated);
  const [hiddenServerAlerts, setHiddenServerAlerts] = useState<Set<string>>(new Set());
  const [acknowledgedServerAlerts, setAcknowledgedServerAlerts] = useState<Set<string>>(new Set());
  const serverAlerts = serverAlertEvents(readServerAlerts(checksPoll.data), hiddenServerAlerts, acknowledgedServerAlerts);
  const unreadable = isOperatorAuthenticated && checksPoll.error ? [alertsUnreadableEvent(checksPoll.error, checksPoll.at ?? Date.now())] : [];
  const shownAlerts = [...killSwitchStateAlert(isHalted, haltedSinceAt), ...unreadable, ...serverAlerts, ...alerts];
  const seenServerAlerts = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const a of serverAlerts) {
      if (seenServerAlerts.current.has(a.id)) continue;
      seenServerAlerts.current.add(a.id);
      hftAudio.playAlertBeep(a.level === 'CRITICAL' ? 'CRITICAL' : 'WARNING');
    }
  });

  // R10-4: an exit the bot makes by itself (take-profit, stop-loss, trailing, stale) is announced, with what it sold and the PnL
  const watchedOpen = useRef<WatchedPosition[] | null>(null);
  useEffect(() => {
    if (!isOperatorAuthenticated) { watchedOpen.current = null; return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await authFetch('/api/workstation/positions?status=ACTIVE');
        if (!r.ok || !alive) return;
        const open: WatchedPosition[] = (await r.json())?.positions ?? [];
        const before = watchedOpen.current;
        watchedOpen.current = open;
        if (!before) return; // the first read is the baseline
        const ids = new Set(open.map((p) => p.id));
        const changed = before.some((p) => !ids.has(p.id) || open.find((q) => q.id === p.id)?.tokenQuantityRaw !== p.tokenQuantityRaw);
        if (!changed) return;
        let all: WatchedPosition[] = open;
        if (before.some((p) => !ids.has(p.id))) {
          const ra = await authFetch('/api/workstation/positions');
          if (ra.ok) all = (await ra.json())?.positions ?? open;
        }
        if (alive) for (const a of exitAlerts(before, open, all)) triggerAlert(a.level, a.title, a.message);
      } catch { /* the next read retries; the baseline stays */ }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [isOperatorAuthenticated, triggerAlert]);

  // Q36: a refused WebSocket command is shown, not dropped.
  useEffect(() => {
    const unsub = engineClient.onActionError((m) => triggerAlert('CRITICAL', `COMMAND REFUSED${m.action ? `: ${m.action}` : ''}`, m.error));
    return () => unsub();
  }, [triggerAlert]);

  // R25: the header must show the server's kill-switch state, not a local guess: a panic liquidation, the RPC auto-trip, another
  // tab or a reload all change it without this component knowing.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await authFetch('/api/diagnostics/system');
        if (!alive) return;
        if (!r.ok) { setIsHalted(null); return; } // R10-2: logged out or refused: the state is unknown
        const j = await r.json();
        if (alive) setIsHalted(typeof j?.systemAudit?.killSwitchActive === 'boolean' ? j.systemAudit.killSwitchActive : null);
      } catch { if (alive) setIsHalted(null); }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Emergency kill switch: the server decides. The UI only shows "halted" after the server confirmed it.
  const killInFlight = useRef(false);
  const toggleKillSwitch = async () => {
    if (killInFlight.current) return; // R33: a second click while the first request is out must not send the opposite value
    // R9-1: send the intended state. RESUME needs a confirm, and a RESUME press right after the switch turned on is ignored.
    const press = killSwitchPress(isHalted === true, haltedSince.current, Date.now(), (text) => window.confirm(text));
    if (press.action === 'IGNORE') return;
    killInFlight.current = true;
    const nextHalted = press.activate;
    try {
      const res = await authFetch('/api/execution/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activate: nextHalted }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.killSwitchActive !== nextHalted) {
        throw new Error(body.error || `server answered HTTP ${res.status}`);
      }
      if (nextHalted) haltedSince.current = Date.now();
      setIsHalted(nextHalted);
      hftAudio.playKillSwitch(); // R33: after the server confirmed, not before
      // R10-1: the ENGAGED alert comes from the state (killSwitchStateAlert below), so a reset here or in another tab removes it
      if (!nextHalted) {
        // R26: the reset lifts only the kill switch. An open circuit breaker or an all-trading halt still refuses orders.
        const blockers: string[] = [];
        if (body.circuitBreaker === 'OPEN') blockers.push(`the circuit breaker is still OPEN${body.circuitBreakerReset?.reason ? ` (${body.circuitBreakerReset.reason})` : ''}`);
        if (body.haltReason) blockers.push(`all trading is still halted (${body.haltReason})`);
        triggerAlert(
          blockers.length ? 'WARNING' : 'INFO',
          'KILL SWITCH RESET',
          blockers.length
            ? `The kill switch is off, but new orders are still refused: ${blockers.join('; ')}. LIVE trading stays disarmed until you arm it.`
            : 'The kill switch is off. LIVE trading stays disarmed until you arm it.'
        );
      }
    } catch (err: any) {
      triggerAlert(
        'CRITICAL',
        'KILL SWITCH NOT CONFIRMED',
        `The server did not confirm the kill switch (${err?.message || 'request failed'}). Assume trading is NOT halted; sign in as operator and retry.`
      );
    } finally {
      killInFlight.current = false;
    }
  };

  return (
    <div className="min-h-screen bg-[#06080D] text-slate-200 flex flex-col selection:bg-cyan-500 selection:text-white">
      {/* Q10b / Q41: mode, cluster, rpc and the age of the server's answer, always visible */}
      <PanelErrorBoundary name="Mode banner"><TradingModeBanner /></PanelErrorBoundary>
      {/* 1. INSTITUTIONAL HEADER BAR - PERMANENTLY DOCKED & ALWAYS ACCESSIBLE */}
      <Header
        kpis={kpis}
        isHalted={isHalted}
        onToggleKillSwitch={toggleKillSwitch}
        onOpenAiDiagnostics={() => setIsAiDiagnosticsOpen(true)}
        onOpenSystemChecks={() => setIsSystemChecksOpen(true)}
        onOpenAutoPipeline={() => setIsAutoPipelineOpen(true)}
        onOpenMemecoinSniper={() => {
          setIsPlugAndPlayOpen(false);
          setIsMemecoinSniperOpen(true);
        }}
        onOpenLatency={() => setIsLatencyOpen(true)}
        onOpenBacktestModal={() => setIsBacktestModalOpen(true)}
        onOpenPlugAndPlayTrading={() => {
          setIsMemecoinSniperOpen(false);
          setIsPlugAndPlayOpen(true);
        }}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
        isOperatorAuthenticated={isOperatorAuthenticated}
        activeFeed={activeFeed}
        onSelectFeed={setActiveFeed}
        isMemecoinSniperOpen={isMemecoinSniperOpen}
        isPlugAndPlayOpen={isPlugAndPlayOpen}
        onSelectMainView={(view) => {
          if (view === 'DASHBOARD') {
            setIsMemecoinSniperOpen(false);
            setIsPlugAndPlayOpen(false);
          } else if (view === 'TELEGRAM_FEED') {
            setIsPlugAndPlayOpen(false);
            setIsMemecoinSniperOpen(true);
          } else if (view === 'PLUG_AND_PLAY') {
            setIsMemecoinSniperOpen(false);
            setIsPlugAndPlayOpen(true);
          }
        }}
      />

      {/* 2. HOME: the token board (H1). Launches / Watching / Holding for Pump.fun on Solana. */}
      <main className="flex-1 p-4 lg:p-6 grid grid-cols-12 gap-5 max-w-[1920px] mx-auto w-full content-start">
        <PanelErrorBoundary name="Token board"><TokenBoard onSelect={setSelectedMint} selected={selectedMint} /></PanelErrorBoundary>
        <aside className="col-span-12 lg:col-span-4 flex flex-col space-y-5" data-testid="home-side">
          <PanelErrorBoundary name="Curve panel"><CurvePanel mint={selectedMint} /></PanelErrorBoundary>
          <PanelErrorBoundary name="Auto panel"><AutoPanel /></PanelErrorBoundary>
        </aside>
      </main>

      {/* 3. ALERT SYSTEM POPUPS */}
      <PanelErrorBoundary name="Alerts">
        <AlertSystem
          alerts={shownAlerts}
          onDismissAlert={(id) => {
            if (id.startsWith('server-')) setHiddenServerAlerts((prev) => new Set(prev).add(id));
            else setAlerts((prev) => prev.filter((a) => a.id !== id));
          }}
          onAcknowledgeAlert={(alert) => {
            if (!alert.serverAck) return;
            void acknowledgeServerAlert(authFetch, alert.serverAck).then((err) => {
              if (err === null) setAcknowledgedServerAlerts((prev) => new Set(prev).add(alert.id));
              else triggerAlert('WARNING', `${alert.title} NOT ACKNOWLEDGED`, err);
            });
          }}
          onClearAll={() => {
            setAlerts([]);
            setHiddenServerAlerts((prev) => { const next = new Set(prev); for (const a of serverAlerts) if (!a.sticky) next.add(a.id); return next; });
          }}
        />
      </PanelErrorBoundary>

      {/* 4. MODALS */}
      <PanelErrorBoundary name="AI diagnostics">
        <AiDiagnosticsModal
          isOpen={isAiDiagnosticsOpen}
          onClose={() => setIsAiDiagnosticsOpen(false)}
        />
      </PanelErrorBoundary>

      <PanelErrorBoundary name="System checks">
        <SystemChecksModal isOpen={isSystemChecksOpen} onClose={() => setIsSystemChecksOpen(false)} />
      </PanelErrorBoundary>
      <PanelErrorBoundary name="Latency">
        <ExecutionLatencyModal isOpen={isLatencyOpen} onClose={() => setIsLatencyOpen(false)} />
      </PanelErrorBoundary>
      <PanelErrorBoundary name="Auto pipeline">
        <AutoPipelineModal
          isOpen={isAutoPipelineOpen}
          onClose={() => setIsAutoPipelineOpen(false)}
        />
      </PanelErrorBoundary>

      <PanelErrorBoundary name="Sniper">
        <MemecoinSocialSniperModal
          isOpen={isMemecoinSniperOpen}
          onClose={() => setIsMemecoinSniperOpen(false)}
          onAlertTrigger={triggerAlert}
        />
      </PanelErrorBoundary>

      <PanelErrorBoundary name="Backtest">
        <BacktestModal
          isOpen={isBacktestModalOpen}
          onClose={() => setIsBacktestModalOpen(false)}
        />
      </PanelErrorBoundary>

      <PanelErrorBoundary name="Plug & Play">
        <PlugAndPlayTradingModal
          isOpen={isPlugAndPlayOpen}
          onClose={() => setIsPlugAndPlayOpen(false)}
        />
      </PanelErrorBoundary>

      <PanelErrorBoundary name="Sign-in">
        <AuthModal
          isOpen={isAuthModalOpen}
          onClose={() => setIsAuthModalOpen(false)}
          onAuthenticated={handleAuthenticated}
        />
      </PanelErrorBoundary>
    </div>
  );
}
