import { TradingModeBanner } from './components/TradingModeBanner';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TradingBot, NetworkStressConfig, PerformanceKPIs, AlertEvent } from './types';
import { hftAudio } from './utils/audio';

import { Header } from './components/Header';
import { AlertSystem } from './components/AlertSystem';
import { DeployBotModal } from './components/DeployBotModal';
import { AiDiagnosticsModal } from './components/AiDiagnosticsModal';
import { UnitTestModal } from './components/UnitTestModal';
import { EngineConsoleModal } from './components/EngineConsoleModal';
import { MemecoinSocialSniperModal } from './components/MemecoinSocialSniperModal';
import { MicrostructureRealismModal } from './components/MicrostructureRealismModal';
import { BacktestModal } from './components/BacktestModal';
import { PlugAndPlayTradingModal } from './components/PlugAndPlayTradingModal';
import { AuthModal } from './components/AuthModal';
import { engineClient, getOperatorSessionToken, authFetch } from './services/engineClient';
import { TokenBoard } from './components/TokenBoard';
import { CurvePanel } from './components/CurvePanel';
import { AutoPanel } from './components/AutoPanel';

// Bot configuration only. Performance fields (pnl, winRate, tradesCount, opsPerSec) start at zero and
// must come from real fills; this UI never fabricates fills or PnL (B1).
export const INITIAL_BOTS: TradingBot[] = [
  {
    id: 'b1',
    name: 'Optiver Cointegration Arbitrage',
    archetype: 'STATISTICAL_ARBITRAGE',
    assetClass: 'CRYPTO',
    symbol: 'BTC/USDT',
    isRunning: false,
    winRate: 0,
    pnl: 0,
    tradesCount: 0,
    opsPerSec: 0,
    maxDailyLoss: 5000,
    slippageLimitBps: 1.5,
    leverage: 10,
    gamma: 0.1,
    kappa: 1.8,
  },
  {
    id: 'b2',
    name: 'Jump Micro-Maker V4',
    archetype: 'MARKET_MAKING',
    assetClass: 'EQUITIES',
    symbol: 'NVDA/USD',
    isRunning: false,
    winRate: 0,
    pnl: 0,
    tradesCount: 0,
    opsPerSec: 0,
    maxDailyLoss: 7500,
    slippageLimitBps: 1.2,
    leverage: 8,
    gamma: 0.12,
    kappa: 2.2,
  },
  {
    id: 'b3',
    name: 'Flow Imbalance Sentinel',
    archetype: 'ORDER_BOOK_IMBALANCE',
    assetClass: 'CRYPTO',
    symbol: 'ETH/USDT',
    isRunning: false,
    winRate: 0,
    pnl: 0,
    tradesCount: 0,
    opsPerSec: 0,
    maxDailyLoss: 3000,
    slippageLimitBps: 2.0,
    leverage: 5,
    gamma: 0.08,
    kappa: 1.5,
  },
  {
    id: 'b4',
    name: 'Sub-MS Cross-Exchange Latency Arb',
    archetype: 'LATENCY_ARBITRAGE',
    assetClass: 'FX',
    symbol: 'EUR/USD',
    isRunning: false,
    winRate: 0,
    pnl: 0,
    tradesCount: 0,
    opsPerSec: 0,
    maxDailyLoss: 10000,
    slippageLimitBps: 0.8,
    leverage: 20,
    gamma: 0.15,
    kappa: 3.0,
  },
  {
    id: 'b5',
    name: 'Momentum Order Flow Scalper',
    archetype: 'MOMENTUM_SCALPING',
    assetClass: 'COMMODITIES',
    symbol: 'XAU/USD',
    isRunning: false,
    winRate: 0,
    pnl: 0,
    tradesCount: 0,
    opsPerSec: 0,
    maxDailyLoss: 4500,
    slippageLimitBps: 2.5,
    leverage: 12,
    gamma: 0.1,
    kappa: 1.2,
  },
];

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
  const [selectedSymbol, setSelectedSymbol] = useState('BTC/USDT');

  // Strategy Fleet
  const [bots, setBots] = useState<TradingBot[]>(INITIAL_BOTS);

  // Network Stress Config
  const [stressConfig] = useState<NetworkStressConfig>({
    isStressActive: false,
    profile: 'GAUSSIAN',
    baseLatencyMs: 0.65,
    jitterMs: 1.8,
    packetLossPct: 0.0,
    exchangeDisconnect: false,
  });


  // Capital Tier State ($10 Micro Account vs $500,000 Institutional)
  const [capitalTier, setCapitalTier] = useState<'MICRO_10' | 'INSTITUTIONAL'>('MICRO_10');

  // KPIs & Risk Matrix (Initialized for $10 Micro Account)
  const [kpis, setKpis] = useState<PerformanceKPIs>(makeEmptyKpis(10));


  // Stable references for stream callbacks to ensure persistent connection without reconnect churn
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const stressConfigRef = useRef(stressConfig);
  stressConfigRef.current = stressConfig;
  const capitalTierRef = useRef(capitalTier);
  capitalTierRef.current = capitalTier;
  const isHaltedRef = useRef(isHalted);
  isHaltedRef.current = isHalted;
  const selectedSymbolRef = useRef(selectedSymbol);
  selectedSymbolRef.current = selectedSymbol;

  // Alerts
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);

  // Modals
  const [isDeployModalOpen, setIsDeployModalOpen] = useState(false);
  const [isAiDiagnosticsOpen, setIsAiDiagnosticsOpen] = useState(false);
  const [isUnitTestsOpen, setIsUnitTestsOpen] = useState(false);
  const [isEngineConsoleOpen, setIsEngineConsoleOpen] = useState(false);
  const [isMemecoinSniperOpen, setIsMemecoinSniperOpen] = useState(false);
  const [isRealismModalOpen, setIsRealismModalOpen] = useState(false);
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
  };

  // Sync engine trade fills with audio and workstation blotter
  useEffect(() => {
    const unsub = engineClient.onTrade((trade) => {
      hftAudio.playTradeFill(trade.side === 'BUY');
    });
    return () => unsub();
  }, []);

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
        if (body.circuitBreaker === 'OPEN') blockers.push('the circuit breaker is still OPEN');
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

  // Toggle Capital Allocation Tier ($10 Micro Account vs $500,000 Institutional)
  const toggleCapitalTier = () => {
    const nextTier = capitalTier === 'MICRO_10' ? 'INSTITUTIONAL' : 'MICRO_10';
    setCapitalTier(nextTier);
    const isMicro = nextTier === 'MICRO_10';
    engineClient.setMicro10Mode(isMicro);

    if (isMicro) {
      setKpis(makeEmptyKpis(10));
      triggerAlert(
        'INFO',
        'SWITCHED TO $10.00 MICRO ACCOUNT',
        'All bot quotas and pre-trade risk checks scaled to Binance 5 USDT min notional. Max order: $10.00.'
      );
    } else {
      setKpis(makeEmptyKpis(500000));
      triggerAlert(
        'INFO',
        'SWITCHED TO $500K INSTITUTIONAL TIER',
        'Institutional capital restored. Standard multi-tier ladder quoting active.'
      );
    }
  };

  // Switch Symbol
  const handleSelectSymbol = (sym: string) => {
    setSelectedSymbol(sym);
    triggerAlert('INFO', 'DMA FEED SWITCHED', `Subscribed to live ${sym} order depth and trades.`);
  };

  // Deploy New Bot
  const handleDeployBot = (bot: TradingBot) => {
    setBots((prev) => [bot, ...prev]);
    triggerAlert(
      'INFO',
      'NEW STRATEGY DEPLOYED',
      `${bot.name} (${bot.archetype}) deployed to ${bot.symbol}.`
    );
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
        onOpenDeployModal={() => setIsDeployModalOpen(true)}
        onOpenAiDiagnostics={() => setIsAiDiagnosticsOpen(true)}
        onOpenUnitTests={() => setIsUnitTestsOpen(true)}
        onOpenEngineConsole={() => setIsEngineConsoleOpen(true)}
        onOpenMemecoinSniper={() => {
          setIsPlugAndPlayOpen(false);
          setIsMemecoinSniperOpen(true);
        }}
        onOpenRealismModal={() => setIsRealismModalOpen(true)}
        onOpenBacktestModal={() => setIsBacktestModalOpen(true)}
        onOpenPlugAndPlayTrading={() => {
          setIsMemecoinSniperOpen(false);
          setIsPlugAndPlayOpen(true);
        }}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
        isOperatorAuthenticated={isOperatorAuthenticated}
        activeFeed={activeFeed}
        onSelectFeed={setActiveFeed}
        capitalTier={capitalTier}
        onToggleCapitalTier={toggleCapitalTier}
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
        alerts={alerts}
        onDismissAlert={(id) => setAlerts((prev) => prev.filter((a) => a.id !== id))}
        onClearAll={() => setAlerts([])}
      />

      {/* 4. MODALS */}
      <DeployBotModal
        isOpen={isDeployModalOpen}
        onClose={() => setIsDeployModalOpen(false)}
        onDeploy={handleDeployBot}
      />

      <AiDiagnosticsModal
        isOpen={isAiDiagnosticsOpen}
        onClose={() => setIsAiDiagnosticsOpen(false)}
        bots={bots}
        kpis={kpis}
        stressConfig={stressConfig}
      />

      <UnitTestModal
        isOpen={isUnitTestsOpen}
        onClose={() => setIsUnitTestsOpen(false)}
      />

      <EngineConsoleModal
        isOpen={isEngineConsoleOpen}
        onClose={() => setIsEngineConsoleOpen(false)}
        currentSymbol={selectedSymbol}
        onSelectSymbol={handleSelectSymbol}
      />

      <MemecoinSocialSniperModal
        isOpen={isMemecoinSniperOpen}
        onClose={() => setIsMemecoinSniperOpen(false)}
        capitalTier={capitalTier}
        onAlertTrigger={triggerAlert}
      />

      <MicrostructureRealismModal
        isOpen={isRealismModalOpen}
        onClose={() => setIsRealismModalOpen(false)}
        onAlertTrigger={triggerAlert}
      />

      <BacktestModal
        isOpen={isBacktestModalOpen}
        onClose={() => setIsBacktestModalOpen(false)}
        currentCapitalTier={capitalTier}
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
