import React, { useState, useEffect, useRef } from 'react';
import {
  Activity,
  AlertOctagon,
  Cpu,
  PlusCircle,
  Volume2,
  VolumeX,
  Sparkles,
  CheckCircle2,
  ShieldAlert,
  Server,
  KeyRound,
  Lock,
  Coins,
  Globe,
  Radio,
  TrendingUp,
  Zap,
  ChevronDown,
  Layers,
  BarChart2,
} from 'lucide-react';
import { PerformanceKPIs } from '../types';
import { hftAudio } from '../utils/audio';
import { authFetch } from '../services/engineClient';

interface HeaderProps {
  kpis: PerformanceKPIs;
  isHalted: boolean;
  onToggleKillSwitch: () => void;
  onOpenDeployModal: () => void;
  onOpenAiDiagnostics: () => void;
  onOpenUnitTests: () => void;
  onOpenGatewayModal: () => void;
  onOpenEngineConsole: () => void;
  onOpenMemecoinSniper?: () => void;
  onOpenRealismModal?: () => void;
  onOpenBacktestModal?: () => void;
  onOpenPlugAndPlayTrading?: () => void;
  onOpenAuthModal?: () => void;
  isOperatorAuthenticated?: boolean;
  activeFeed: string;
  onSelectFeed: (feed: string) => void;
  exchangePingMs?: number;
  capitalTier?: 'MICRO_10' | 'INSTITUTIONAL';
  onToggleCapitalTier?: () => void;
  isMemecoinSniperOpen?: boolean;
  isPlugAndPlayOpen?: boolean;
  onSelectMainView?: (view: 'DASHBOARD' | 'TELEGRAM_FEED' | 'PLUG_AND_PLAY') => void;
}

export const Header: React.FC<HeaderProps> = ({
  kpis,
  isHalted,
  onToggleKillSwitch,
  onOpenDeployModal,
  onOpenAiDiagnostics,
  onOpenUnitTests,
  onOpenGatewayModal,
  onOpenEngineConsole,
  onOpenMemecoinSniper,
  onOpenRealismModal,
  onOpenBacktestModal,
  onOpenPlugAndPlayTrading,
  onOpenAuthModal,
  isOperatorAuthenticated = false,
  activeFeed,
  onSelectFeed,
  capitalTier = 'MICRO_10',
  onToggleCapitalTier,
  isMemecoinSniperOpen = false,
  isPlugAndPlayOpen = false,
  onSelectMainView,
}) => {
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [timeString, setTimeString] = useState('');
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const toolsMenuRef = useRef<HTMLDivElement | null>(null);

  // Live Auto-Profit Ticker State (fetched from walletTrader) - Clean initial state (B22)
  const [profitSummary, setProfitSummary] = useState<{
    totalPnLUsd: number;
    totalPnLPct: number;
    activeCount: number;
  }>({ totalPnLUsd: 0.0, totalPnLPct: 0.0, activeCount: 0 });

  useEffect(() => {
    const fetchProfit = async () => {
      try {
        const res = await authFetch('/api/wallet/state');
        if (res.ok) {
          const json = await res.json();
          if (json.data) {
            setProfitSummary({
              totalPnLUsd: Number(json.data.totalPnLUsd || 0),
              totalPnLPct: Number(json.data.totalPnLPct || 0),
              activeCount: Number(json.data.activePositionsCount || 0),
            });
          }
        }
      } catch {}
    };
    fetchProfit();
    const interval = setInterval(fetchProfit, 3500);
    return () => clearInterval(interval);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(event.target as Node)) {
        setIsToolsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const updateClock = () => {
      const d = new Date();
      const utc = d.toUTCString().split(' ')[4];
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      setTimeString(`${utc}.${ms} UTC`);
    };
    const interval = setInterval(updateClock, 100);
    return () => clearInterval(interval);
  }, []);

  const toggleSound = () => {
    const next = !audioEnabled;
    setAudioEnabled(next);
    hftAudio.setEnabled(next);
  };

  const handleNavClick = (view: 'DASHBOARD' | 'TELEGRAM_FEED' | 'PLUG_AND_PLAY') => {
    if (onSelectMainView) {
      onSelectMainView(view);
    } else {
      if (view === 'TELEGRAM_FEED' && onOpenMemecoinSniper) onOpenMemecoinSniper();
      if (view === 'PLUG_AND_PLAY' && onOpenPlugAndPlayTrading) onOpenPlugAndPlayTrading();
    }
  };

  return (
    <header
      id="apex-header"
      className="h-16 border-b border-[#1E293B] bg-[#0A0E17]/98 backdrop-blur px-3 sm:px-4 lg:px-6 flex items-center justify-between sticky top-0 z-50 w-full"
    >
      {/* 1. BRAND & FEED SELECTOR */}
      <div className="flex items-center space-x-2.5 sm:space-x-3 flex-shrink-0">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-tr from-[#2979FF] via-[#00E5FF] to-[#00E676] p-[1px] shadow-md shadow-cyan-500/20 flex-shrink-0">
          <div className="h-full w-full bg-[#06080D] rounded-[7px] flex items-center justify-center font-mono font-black text-xs tracking-wider text-cyan-400">
            AQ
          </div>
        </div>

        <div>
          <div className="flex items-center space-x-2">
            <span className="font-black tracking-tight text-white text-sm sm:text-base font-sans whitespace-nowrap">
              APEX QUANT
            </span>

            {/* LIVE FEED SELECTOR */}
            <div className="flex items-center space-x-1.5 px-2 py-0.5 rounded bg-[#0D131F] border border-[#1E293B]">
              <span className="relative flex h-2 w-2">
                <span
                  className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                    isHalted ? 'bg-red-500' : 'bg-[#00E676]'
                  }`}
                />
                <span
                  className={`relative inline-flex rounded-full h-2 w-2 ${
                    isHalted ? 'bg-red-500' : 'bg-[#00E676]'
                  }`}
                />
              </span>
              <select
                aria-label="Active Exchange Feed"
                value={activeFeed}
                onChange={(e) => onSelectFeed(e.target.value)}
                className="bg-transparent text-[10px] sm:text-[11px] font-mono font-bold text-cyan-400 outline-none cursor-pointer"
              >
                <option value="CME_AURORA" className="bg-[#0D131F] text-white">
                  CME AURORA (0.42ms)
                </option>
                <option value="EQUINIX_NY4" className="bg-[#0D131F] text-white">
                  EQUINIX NY4 (0.68ms)
                </option>
                <option value="BINANCE_CROSS" className="bg-[#0D131F] text-white">
                  BINANCE SPOT (L2)
                </option>
                <option value="TOKYO_TY3" className="bg-[#0D131F] text-white">
                  TOKYO TY3 (1.12ms)
                </option>
              </select>
            </div>
          </div>

          <div className="hidden lg:flex items-center space-x-2 text-[10px] text-slate-400 font-mono mt-0.5">
            <span className="text-emerald-400 flex items-center space-x-1">
              <Server className="w-2.5 h-2.5 inline mr-1 text-emerald-400" />
              Direct Kernel Bypass • PTP 1588v2
            </span>
            <span className="text-slate-500">|</span>
            <span className="text-slate-400 font-semibold">{timeString}</span>
          </div>
        </div>
      </div>

      {/* 2. PRIMARY NAVIGATION HUB (Workstation / Telegram Tracker / Plug & Play) */}
      <nav aria-label="Main Navigation" className="flex items-center space-x-1 p-1 rounded-xl bg-[#0D1424] border border-[#1E293B] flex-shrink-0 mx-1 sm:mx-2">
        {/* Workstation Tab */}
        <button
          id="btn-nav-workstation"
          onClick={() => handleNavClick('DASHBOARD')}
          className={`px-2.5 sm:px-3 py-1 rounded-lg text-xs font-mono font-bold transition flex items-center space-x-1.5 ${
            !isMemecoinSniperOpen && !isPlugAndPlayOpen
              ? 'bg-gradient-to-r from-blue-600 to-cyan-600 text-white shadow-sm shadow-cyan-500/30'
              : 'text-slate-400 hover:text-white hover:bg-[#141B2D]'
          }`}
          title="Return to Main HFT Workstation Dashboard (L2 Order Depth, Execution Tape, P&L Engine)"
        >
          <Cpu className="w-3.5 h-3.5" />
          <span>Workstation</span>
        </button>

        {/* Telegram Memecoin Feed Tracker Tab */}
        <button
          id="btn-nav-telegram-tracker"
          onClick={() => handleNavClick('TELEGRAM_FEED')}
          className={`px-2.5 sm:px-3 py-1 rounded-lg text-xs font-mono font-bold transition flex items-center space-x-1.5 ${
            isMemecoinSniperOpen
              ? 'bg-gradient-to-r from-rose-600 to-blue-600 text-white shadow-md shadow-rose-500/30 border border-rose-400/40'
              : 'text-rose-300 hover:text-white hover:bg-rose-950/40'
          }`}
          title="Open Telegram Memecoin Feed Tracker & Pump.fun Hot Callouts"
        >
          <Radio className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
          <span className="hidden sm:inline">Telegram</span> Tracker
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 font-black border border-rose-500/30">
            HOT 🔥
          </span>
        </button>

        {/* Plug & Play Auto-Profit Tab */}
        <button
          id="btn-nav-plug-and-play"
          onClick={() => handleNavClick('PLUG_AND_PLAY')}
          className={`px-2.5 sm:px-3 py-1 rounded-lg text-xs font-mono font-bold transition flex items-center space-x-1.5 ${
            isPlugAndPlayOpen
              ? 'bg-gradient-to-r from-amber-600 to-emerald-600 text-white shadow-md shadow-emerald-500/30 border border-emerald-400/40'
              : 'text-emerald-300 hover:text-white hover:bg-emerald-950/40'
          }`}
          title="Open Plug & Play Live Solana Wallet & Auto-Pilot Profit Engine"
        >
          <Zap className="w-3.5 h-3.5 text-amber-400" />
          <span className="hidden sm:inline">Auto-Profit</span>
          <span className="sm:hidden">Profit</span>
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-black border border-emerald-500/30">
            LIVE ⚡
          </span>
        </button>
      </nav>

      {/* 3. RIGHT CONTROLS: TIER, AUTO-PROFIT PILL, QUANT SUITE, DEPLOY, KILL SWITCH */}
      <div className="flex items-center space-x-1.5 sm:space-x-2 flex-shrink-0">
        {/* Capital Tier Switcher ($10 Micro vs $500K Institutional) */}
        {onToggleCapitalTier && (
          <button
            id="btn-capital-tier-toggle"
            onClick={onToggleCapitalTier}
            title={
              capitalTier === 'MICRO_10'
                ? 'Current: $10.00 Micro Account. Click to switch to $500k Institutional.'
                : 'Current: $500,000 Institutional Tier. Click to switch to $10.00 Micro Account.'
            }
            className={`px-2 py-1 rounded-lg border text-[11px] font-mono transition flex items-center space-x-1 ${
              capitalTier === 'MICRO_10'
                ? 'bg-amber-950/70 border-amber-500/60 text-amber-300 hover:bg-amber-900/60 shadow-sm shadow-amber-500/20'
                : 'bg-[#141B2D] border-[#1E293B] text-slate-300 hover:text-white'
            }`}
          >
            <Coins className="w-3 h-3 text-amber-400" />
            <span className="font-bold">{capitalTier === 'MICRO_10' ? '$10 Micro' : '$500K'}</span>
          </button>
        )}

        {/* Live Auto-Profit Pill (Clickable directly to Plug & Play Console) */}
        <button
          id="btn-auto-profit-ticker"
          onClick={() => handleNavClick('PLUG_AND_PLAY')}
          title="Real-Time Autonomous Profit Generator Active. Click to view live wallet positions and take profits."
          className="hidden md:flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-emerald-950/70 hover:bg-emerald-900/70 border border-emerald-500/40 text-[11px] font-mono text-emerald-300 transition shadow-sm shadow-emerald-500/15 group"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
          <span className="font-bold tracking-tight text-emerald-200">
            +${profitSummary.totalPnLUsd.toFixed(2)}
          </span>
          <span className="text-[10px] text-emerald-400/80">
            (+{profitSummary.totalPnLPct.toFixed(1)}%)
          </span>
        </button>

        {/* Direct Quant Tools (Expanded on 2XL screens) */}
        <div className="hidden 2xl:flex items-center space-x-1.5">
          <button
            id="btn-engine-console"
            onClick={onOpenEngineConsole}
            title="Core High-Frequency Execution Engine (WAL & DMA)"
            className="px-2 py-1 rounded-lg bg-[#10192A] hover:bg-[#1A263D] border border-cyan-500/40 text-[11px] font-mono text-cyan-300 hover:text-white transition flex items-center space-x-1"
          >
            <Cpu className="w-3 h-3 text-cyan-400" />
            <span>Engine</span>
          </button>

          {onOpenBacktestModal && (
            <button
              id="btn-open-backtest"
              onClick={onOpenBacktestModal}
              title="60-Day Historical Backtest with Bonding Curves & MEV"
              className="px-2 py-1 rounded-lg bg-emerald-950/70 hover:bg-emerald-900/70 border border-emerald-500/40 text-[11px] font-mono text-emerald-300 hover:text-white transition flex items-center space-x-1"
            >
              <TrendingUp className="w-3 h-3 text-emerald-400" />
              <span>Backtest</span>
            </button>
          )}

          <button
            id="btn-unit-tests"
            onClick={onOpenUnitTests}
            title="700 High-Stakes Financial Unit Tests"
            className="px-2 py-1 rounded-lg bg-[#141B2D] hover:bg-[#1E293B] border border-emerald-500/30 text-[11px] font-mono text-emerald-300 hover:text-white transition flex items-center space-x-1"
          >
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            <span>700 Tests</span>
          </button>
        </div>

        {/* Quant Tools Dropdown Menu (Guarantees clean layout on all screens < 1536px) */}
        <div className="relative 2xl:hidden" ref={toolsMenuRef}>
          <button
            id="btn-quant-tools-dropdown"
            onClick={() => setIsToolsOpen(!isToolsOpen)}
            className="px-2.5 py-1 rounded-lg bg-[#141B2D] hover:bg-[#1E293B] border border-slate-700 text-[11px] font-mono text-slate-300 hover:text-white transition flex items-center space-x-1"
          >
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Quant Tools</span>
            <span className="sm:hidden">Tools</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {isToolsOpen && (
            <div className="absolute right-0 mt-2 w-56 bg-[#0E1526] border border-[#1E293B] rounded-xl shadow-2xl py-1 z-50 font-mono text-xs text-slate-200 divide-y divide-[#1E293B]">
              <div className="py-1">
                <button
                  onClick={() => {
                    onOpenEngineConsole();
                    setIsToolsOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-[#1A263D] flex items-center justify-between text-cyan-300"
                >
                  <span className="flex items-center space-x-2">
                    <Cpu className="w-3.5 h-3.5" />
                    <span>Core Engine</span>
                  </span>
                  <span className="text-[9px] px-1 rounded bg-emerald-500/20 text-emerald-300">ASYNC</span>
                </button>

                <button
                  onClick={() => {
                    onOpenGatewayModal();
                    setIsToolsOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-[#1A263D] flex items-center justify-between text-amber-300"
                >
                  <span className="flex items-center space-x-2">
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>DMA Gateway & Risk</span>
                  </span>
                  <span className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-300">DMA</span>
                </button>

                {onOpenBacktestModal && (
                  <button
                    onClick={() => {
                      onOpenBacktestModal();
                      setIsToolsOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-[#1A263D] flex items-center justify-between text-emerald-300"
                  >
                    <span className="flex items-center space-x-2">
                      <TrendingUp className="w-3.5 h-3.5" />
                      <span>60D Backtest</span>
                    </span>
                    <span className="text-[9px] px-1 rounded bg-emerald-500/20 text-emerald-300">2 MO</span>
                  </button>
                )}
              </div>

              <div className="py-1">
                <button
                  onClick={() => {
                    onOpenUnitTests();
                    setIsToolsOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-[#1A263D] flex items-center justify-between text-slate-300 hover:text-white"
                >
                  <span className="flex items-center space-x-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>700 Unit Tests</span>
                  </span>
                  <span className="text-[9px] px-1 rounded bg-emerald-500/20 text-emerald-300">LIVE</span>
                </button>

                <button
                  onClick={() => {
                    onOpenAiDiagnostics();
                    setIsToolsOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-[#1A263D] flex items-center space-x-2 text-cyan-300 hover:text-white"
                >
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Quant AI Diagnostics</span>
                </button>

                {onOpenRealismModal && (
                  <button
                    onClick={() => {
                      onOpenRealismModal();
                      setIsToolsOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-[#1A263D] flex items-center justify-between text-slate-300 hover:text-white"
                  >
                    <span className="flex items-center space-x-2">
                      <Globe className="w-3.5 h-3.5 text-slate-400" />
                      <span>Co-Loc Realism</span>
                    </span>
                    <span className="text-[9px] text-cyan-400">1.15ms</span>
                  </button>
                )}

                {onOpenAuthModal && (
                  <button
                    onClick={() => {
                      onOpenAuthModal();
                      setIsToolsOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-[#1A263D] flex items-center justify-between text-cyan-300 hover:text-white"
                  >
                    <span className="flex items-center space-x-2">
                      <Lock className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Operator Auth</span>
                    </span>
                    <span className={`text-[9px] px-1 rounded ${isOperatorAuthenticated ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>
                      {isOperatorAuthenticated ? 'ACTIVE' : 'REQUIRED'}
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Operator Session Auth Button */}
        {onOpenAuthModal && (
          <button
            id="btn-operator-auth"
            onClick={onOpenAuthModal}
            className={`px-2 py-1 rounded-lg text-xs font-mono font-bold border transition flex items-center space-x-1.5 ${
              isOperatorAuthenticated
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20'
                : 'bg-amber-500/15 border-amber-500/50 text-amber-300 hover:bg-amber-500/25 animate-pulse'
            }`}
            title={
              isOperatorAuthenticated
                ? 'Operator Session Active: Click to view or manage credentials'
                : 'Operator Session Required: Click to authenticate'
            }
          >
            <Lock className="w-3 h-3" />
            <span className="hidden sm:inline">{isOperatorAuthenticated ? 'AUTH' : 'LOG IN'}</span>
          </button>
        )}

        {/* Deploy Strategy Button */}
        <button
          id="btn-deploy-algorithm"
          onClick={onOpenDeployModal}
          disabled={isHalted}
          className={`px-2.5 sm:px-3 py-1 rounded-lg text-xs font-semibold font-mono transition flex items-center space-x-1 shadow-sm ${
            isHalted
              ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
              : 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white border border-cyan-400/30 shadow-cyan-500/20'
          }`}
          title="Deploy a new Algorithmic High-Frequency Strategy"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Deploy</span>
        </button>

        {/* Sound toggle */}
        <button
          id="btn-audio-toggle"
          onClick={toggleSound}
          title={audioEnabled ? 'Mute HFT Audio Beeps' : 'Enable HFT Audio Beeps'}
          className="p-1.5 rounded-lg bg-[#141B2D] border border-[#1E293B] text-slate-400 hover:text-white transition"
        >
          {audioEnabled ? (
            <Volume2 className="w-3.5 h-3.5 text-cyan-400" />
          ) : (
            <VolumeX className="w-3.5 h-3.5 text-slate-500" />
          )}
        </button>

        {/* Emergency Kill Switch */}
        <button
          id="btn-emergency-kill-switch"
          onClick={onToggleKillSwitch}
          className={`px-2.5 sm:px-3 py-1 rounded-lg border text-xs font-black font-mono tracking-wider transition flex items-center space-x-1 ${
            isHalted
              ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/50 text-emerald-400 shadow-lg shadow-emerald-500/15'
              : 'bg-red-500/15 hover:bg-red-500/25 border-red-500/50 text-red-400 shadow-lg shadow-red-500/15 animate-pulse'
          }`}
          title="EMERGENCY CIRCUIT BREAKER - Immediately freeze all trading loops and open orders"
        >
          {isHalted ? (
            <>
              <ShieldAlert className="w-3.5 h-3.5 text-emerald-400" />
              <span>RESUME</span>
            </>
          ) : (
            <>
              <AlertOctagon className="w-3.5 h-3.5 text-red-500" />
              <span className="hidden sm:inline">KILL SWITCH</span>
              <span className="sm:hidden">KILL</span>
            </>
          )}
        </button>
      </div>
    </header>
  );
};

