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
import { readServerAlerts, serverAlertEvents, alertsUnreadableEvent } from './utils/operatorAlerts';


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
  const [isHalted, setIsHalted] = useState(false);
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
  const serverAlerts = serverAlertEvents(readServerAlerts(checksPoll.data), hiddenServerAlerts);
  const unreadable = isOperatorAuthenticated && checksPoll.error ? [alertsUnreadableEvent(checksPoll.error, checksPoll.at ?? Date.now())] : [];
  const shownAlerts = [...unreadable, ...serverAlerts, ...alerts];
  const seenServerAlerts = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const a of serverAlerts) {
      if (seenServerAlerts.current.has(a.id)) continue;
      seenServerAlerts.current.add(a.id);
      hftAudio.playAlertBeep(a.level === 'CRITICAL' ? 'CRITICAL' : 'WARNING');
    }
  });

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
        if (!r.ok) return;
        const j = await r.json();
        if (alive && typeof j?.systemAudit?.killSwitchActive === 'boolean') setIsHalted(j.systemAudit.killSwitchActive);
      } catch { /* keep what is shown */ }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Emergency kill switch: the server decides. The UI only shows "halted" after the server confirmed it.
  const killInFlight = useRef(false);
  const toggleKillSwitch = async () => {
    if (killInFlight.current) return; // R33: a second click while the first request is out must not send the opposite value
    killInFlight.current = true;
    const nextHalted = !isHalted;
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
      setIsHalted(nextHalted);
      hftAudio.playKillSwitch(); // R33: after the server confirmed, not before
      if (nextHalted) {
        triggerAlert(
          'CRITICAL',
          'KILL SWITCH ENGAGED',
          'The server refuses new orders and has disarmed LIVE trading. Open positions are NOT sold: close them from the Plug & Play panel.'
        );
      } else {
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
      <TradingModeBanner />
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
        <TokenBoard onSelect={setSelectedMint} selected={selectedMint} />
        <aside className="col-span-12 lg:col-span-4 flex flex-col space-y-5" data-testid="home-side">
          <CurvePanel mint={selectedMint} />
          <AutoPanel />
        </aside>
      </main>

      {/* 3. ALERT SYSTEM POPUPS */}
      <AlertSystem
        alerts={shownAlerts}
        onDismissAlert={(id) => {
          if (id.startsWith('server-')) setHiddenServerAlerts((prev) => new Set(prev).add(id));
          else setAlerts((prev) => prev.filter((a) => a.id !== id));
        }}
        onClearAll={() => {
          setAlerts([]);
          setHiddenServerAlerts((prev) => { const next = new Set(prev); for (const a of serverAlerts) if (!a.sticky) next.add(a.id); return next; });
        }}
      />

      {/* 4. MODALS */}
      <AiDiagnosticsModal
        isOpen={isAiDiagnosticsOpen}
        onClose={() => setIsAiDiagnosticsOpen(false)}
      />

      <SystemChecksModal isOpen={isSystemChecksOpen} onClose={() => setIsSystemChecksOpen(false)} />
      <ExecutionLatencyModal isOpen={isLatencyOpen} onClose={() => setIsLatencyOpen(false)} />
      <AutoPipelineModal
        isOpen={isAutoPipelineOpen}
        onClose={() => setIsAutoPipelineOpen(false)}
      />

      <MemecoinSocialSniperModal
        isOpen={isMemecoinSniperOpen}
        onClose={() => setIsMemecoinSniperOpen(false)}
        onAlertTrigger={triggerAlert}
      />

      <BacktestModal
        isOpen={isBacktestModalOpen}
        onClose={() => setIsBacktestModalOpen(false)}
      />

      <PlugAndPlayTradingModal
        isOpen={isPlugAndPlayOpen}
        onClose={() => setIsPlugAndPlayOpen(false)}
      />

      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onAuthenticated={handleAuthenticated}
      />
    </div>
  );
}
