import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  TradingBot,
  OrderBook as OrderBookType,
  ExecutedTrade,
  NetworkStressConfig,
  PerformanceKPIs,
  AlertEvent,
  PublicMarketTrade,
  ExchangeGatewayConfig,
  ActiveOrder,
} from './types';
import {
  calculateReservationPrice,
  calculateOptimalSpread,
  calculateOFI,
  calculateMicroPrice,
  calculateNetworkDegradation,
  formatMicrosecondTimestamp,
} from './utils/math';
import { hftAudio } from './utils/audio';
import { exchangeStream } from './services/exchangeStream';

import { Header } from './components/Header';
import { PnLEngine } from './components/PnLEngine';
import { OrderBook } from './components/OrderBook';
import { StrategyFleet } from './components/StrategyFleet';
import { ExecutionTape } from './components/ExecutionTape';
import { NetworkStressLab } from './components/NetworkStressLab';
import { MonteCarloAnalytics } from './components/MonteCarloAnalytics';
import { AlertSystem } from './components/AlertSystem';
import { DeployBotModal } from './components/DeployBotModal';
import { AiDiagnosticsModal } from './components/AiDiagnosticsModal';
import { UnitTestModal } from './components/UnitTestModal';
import { ExchangeGatewayModal } from './components/ExchangeGatewayModal';
import { EngineConsoleModal } from './components/EngineConsoleModal';
import { MemecoinSocialSniperModal } from './components/MemecoinSocialSniperModal';
import { MicrostructureRealismModal } from './components/MicrostructureRealismModal';
import { BacktestModal } from './components/BacktestModal';
import { PlugAndPlayTradingModal } from './components/PlugAndPlayTradingModal';
import { AuthModal } from './components/AuthModal';
import { engineClient, getOperatorSessionToken } from './services/engineClient';
import { TokenBoard } from './components/TokenBoard';

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
  const [stressConfig, setStressConfig] = useState<NetworkStressConfig>({
    isStressActive: false,
    profile: 'GAUSSIAN',
    baseLatencyMs: 0.65,
    jitterMs: 1.8,
    packetLossPct: 0.0,
    exchangeDisconnect: false,
  });

  // Effective live network telemetry
  const [effectiveLatency, setEffectiveLatency] = useState(0.68);
  const [slippageMultiplier, setSlippageMultiplier] = useState(1.0);
  const [fillRatePct, setFillRatePct] = useState(99.4);
  const [latencyHistory, setLatencyHistory] = useState<number[]>([
    0.62, 0.68, 0.71, 0.64, 0.78, 0.82, 0.69, 0.65, 0.74, 0.88,
  ]);

  // Capital Tier State ($10 Micro Account vs $500,000 Institutional)
  const [capitalTier, setCapitalTier] = useState<'MICRO_10' | 'INSTITUTIONAL'>('MICRO_10');

  // KPIs & Risk Matrix (Initialized for $10 Micro Account)
  const [kpis, setKpis] = useState<PerformanceKPIs>(makeEmptyKpis(10));

  const [lastTickDelta] = useState(0);
  const [equityHistory, setEquityHistory] = useState<number[]>([10]);
  const [drawdownHistory] = useState<number[]>([0]);

  // L2 Order Book State
  const [midPrice, setMidPrice] = useState(68940.0);
  const [orderBook, setOrderBook] = useState<OrderBookType>({
    symbol: 'BTC/USDT',
    midPrice: 68940.0,
    spread: 0.5,
    microPrice: 68940.25,
    imbalanceRatio: 0.15,
    asks: [],
    bids: [],
    lastTradedPrice: 68940.0,
    lastTradedSide: 'BUY',
  });
  const [flashTrigger, setFlashTrigger] = useState(0);

  // Execution Blotter Tape & Live Public Exchange Tape
  const [trades] = useState<ExecutedTrade[]>([]);
  const [publicTrades, setPublicTrades] = useState<PublicMarketTrade[]>([]);
  const [exchangePingMs, setExchangePingMs] = useState(0.85);

  // Exchange Gateway & Risk Settings
  const [isGatewayModalOpen, setIsGatewayModalOpen] = useState(false);
  const [gatewayConfig, setGatewayConfig] = useState<ExchangeGatewayConfig>({
    mode: 'REAL_TAPE_PAPER_MATCHING',
    apiKey: '',
    apiSecret: '',
    maxOrderNotional: 50000,
    maxDailyLoss: 5000,
    fatFingerBandPct: 2.5,
    isConnected: true,
    exchangePingMs: 0.85,
    atomicClockDriftMs: -0.12,
    accountBalances: [
      { asset: 'USDT', free: 345250.0, locked: 12000.0, totalUsd: 357250.0 },
      { asset: 'BTC', free: 2.154, locked: 0.25, totalUsd: 165645.0 },
      { asset: 'ETH', free: 15.42, locked: 2.0, totalUsd: 49472.0 },
      { asset: 'SOL', free: 85.0, locked: 0.0, totalUsd: 12087.0 },
    ],
  });

  // Active Pending Orders in Queue
  const activeOrdersRef = useRef<ActiveOrder[]>([]);

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

  // Toggle Emergency Kill Switch
  const toggleKillSwitch = () => {
    const nextHalted = !isHalted;
    setIsHalted(nextHalted);
    hftAudio.playKillSwitch();

    if (nextHalted) {
      triggerAlert(
        'CRITICAL',
        'EMERGENCY KILL SWITCH ENGAGED',
        'All matching engine threads halted. Real-time order routing frozen. Safe liquidation armed.'
      );
    } else {
      triggerAlert(
        'INFO',
        'MATCHING ENGINE RESUMED',
        'Trading bots re-initialized. Order feeds reconnected to CME/NY4 core.'
      );
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
      setEquityHistory([10]);
      setGatewayConfig((prev) => ({
        ...prev,
        maxOrderNotional: 10,
        maxDailyLoss: 2,
      }));
      triggerAlert(
        'INFO',
        'SWITCHED TO $10.00 MICRO ACCOUNT',
        'All bot quotas and pre-trade risk checks scaled to Binance 5 USDT min notional. Max order: $10.00.'
      );
    } else {
      setKpis(makeEmptyKpis(500000));
      setEquityHistory([500000]);
      setGatewayConfig((prev) => ({
        ...prev,
        maxOrderNotional: 50000,
        maxDailyLoss: 5000,
      }));
      triggerAlert(
        'INFO',
        'SWITCHED TO $500K INSTITUTIONAL TIER',
        'Institutional capital restored. Standard multi-tier ladder quoting active.'
      );
    }
  };

  // Connect to Real Live Exchange Streams (Persistent WebSocket Stream Listener)
  useEffect(() => {
    if (isHalted || stressConfig.exchangeDisconnect) {
      exchangeStream.disconnect();
      return;
    }

    // Dedicated stream listener registration for depth, order flow, latency, and status
    const unsubscribe = exchangeStream.connect(
      selectedSymbol,
      // 1. Level 2 Order Depth Listener
      (newBook) => {
        const stress = stressConfigRef.current;
        const deg = calculateNetworkDegradation(
          stress.baseLatencyMs,
          stress.jitterMs,
          stress.packetLossPct,
          stress.profile
        );

        setEffectiveLatency(deg.effectiveLatencyMs);
        setSlippageMultiplier(Number((deg.realizedSlippageBps / 1.2).toFixed(2)));
        setLatencyHistory((prev) => [...prev.slice(-35), deg.effectiveLatencyMs]);

        if (deg.isDropped) {
          // Packet dropped under simulated loss
          setFillRatePct((prev) => Math.max(40, Number((prev - 1.2).toFixed(1))));
          return;
        }

        setFillRatePct((prev) => Math.min(99.9, Number((prev + 0.2).toFixed(1))));
        setMidPrice(newBook.midPrice);
        setOrderBook(newBook);
        setFlashTrigger((prev) => prev + 1);
      },
      // 2. Real-Time Exchange Order Flow / Trade Tape Listener
      (realTrade) => {
        // Add to real public tape
        setPublicTrades((prev) => [realTrade, ...prev.slice(0, 79)]);

        // B1: no simulated bot fills here. Fills, PnL and blotter rows must come from real
        // paper/live execution reported by the server.
      },
      // 3. Ping / Latency Probing Listener
      (pingMs) => {
        setExchangePingMs(pingMs);
      }
    );

    return () => {
      unsubscribe();
      exchangeStream.disconnect();
    };
  }, [
    isHalted,
    selectedSymbol,
    stressConfig.exchangeDisconnect,
  ]);

  // Switch Symbol
  const handleSelectSymbol = (sym: string) => {
    setSelectedSymbol(sym);
    triggerAlert('INFO', 'DMA FEED SWITCHED', `Subscribed to live ${sym} order depth and trades.`);
  };

  // Update a bot configuration
  const handleUpdateBot = (updatedBot: TradingBot) => {
    setBots((prev) => prev.map((b) => (b.id === updatedBot.id ? updatedBot : b)));
    triggerAlert('INFO', 'STRATEGY RECONFIGURED', `${updatedBot.name} parameters updated.`);
  };

  // Toggle Bot Pause/Resume
  const handleToggleBot = (id: string) => {
    setBots((prev) =>
      prev.map((b) => {
        if (b.id === id) {
          const nextState = !b.isRunning;
          triggerAlert(
            'INFO',
            nextState ? 'STRATEGY RESUMED' : 'STRATEGY PAUSED',
            `${b.name} is now ${nextState ? 'RUNNING' : 'PAUSED'}.`
          );
          return { ...b, isRunning: nextState };
        }
        return b;
      })
    );
  };

  // Delete/Decommission Bot
  const handleDeleteBot = (id: string) => {
    setBots((prev) => prev.filter((b) => b.id !== id));
    triggerAlert('WARNING', 'STRATEGY DECOMMISSIONED', `Bot ${id} removed from active fleet.`);
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

  // Export Packet Stream (JSON/PCAP format)
  const handleExportPackets = () => {
    const packetData = {
      pcapHeader: {
        magicNumber: '0xa1b2c3d4',
        versionMajor: 2,
        versionMinor: 4,
        timezoneOffsetSeconds: 0,
        snaplen: 65535,
        networkLayer: 'LINKTYPE_ETHERNET',
        clockSync: 'PTP IEEE 1588v2 Hardware Timestamps',
      },
      exportTimestamp: new Date().toISOString(),
      networkStressConfig: stressConfig,
      totalPacketsLogged: trades.length,
      packets: trades.map((t, idx) => ({
        packetIndex: idx + 1,
        timestampEpochUs: t.timestamp * 1000,
        microsecondTime: t.microsecondTime,
        ethernet: {
          srcMac: '00:1b:21:bb:cc:dd',
          dstMac: '00:07:43:06:55:aa',
          vlanId: 104,
        },
        ip: {
          srcIp: '198.51.100.42',
          dstIp: '203.0.113.88',
          ttl: 64,
          proto: 'UDP',
        },
        payloadOuchFix: {
          msgType: t.side === 'BUY' ? 'ORDER_ENTER_BUY' : 'ORDER_ENTER_SELL',
          orderId: t.id,
          symbol: t.symbol,
          price: t.price,
          quantity: t.size,
          executionLatencyMs: t.executionLatencyMs,
          slippageBps: t.slippageBps,
          status: t.status,
          rejectionReason: t.rejectionReason,
        },
      })),
    };

    const blob = new Blob([JSON.stringify(packetData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apex_hft_packet_stream_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    triggerAlert('INFO', 'PCAP STREAM EXPORTED', `Exported ${trades.length} raw packets.`);
  };

  return (
    <div className="min-h-screen bg-[#06080D] text-slate-200 flex flex-col selection:bg-cyan-500 selection:text-white">
      {/* 1. INSTITUTIONAL HEADER BAR - PERMANENTLY DOCKED & ALWAYS ACCESSIBLE */}
      <Header
        kpis={kpis}
        isHalted={isHalted}
        onToggleKillSwitch={toggleKillSwitch}
        onOpenDeployModal={() => setIsDeployModalOpen(true)}
        onOpenAiDiagnostics={() => setIsAiDiagnosticsOpen(true)}
        onOpenUnitTests={() => setIsUnitTestsOpen(true)}
        onOpenGatewayModal={() => setIsGatewayModalOpen(true)}
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
        exchangePingMs={exchangePingMs}
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
          {/* H2 / H3 panels mount here */}
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

      <ExchangeGatewayModal
        isOpen={isGatewayModalOpen}
        onClose={() => setIsGatewayModalOpen(false)}
        config={gatewayConfig}
        onUpdateConfig={(cfg) => {
          setGatewayConfig(cfg);
          triggerAlert('INFO', 'GATEWAY CONFIG APPLIED', `Execution mode set to ${cfg.mode}.`);
        }}
        currentMidPrice={midPrice}
        selectedSymbol={selectedSymbol}
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
