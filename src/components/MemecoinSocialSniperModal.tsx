import { probeBadge, probeLatency, hostOfService } from '../utils/probeBadge';
import { useTradingMode, liveClickWarning } from '../utils/tradingMode';
import { authorityBadge, authorityTone, holderPct } from '../utils/authorityBadge';
import React, { useState, useEffect } from 'react';
import {
  Send,
  Radio,
  Zap,
  TrendingUp,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  Bot,
  Layers,
  Copy,
  Check,
  ExternalLink,
  Flame,
  ArrowUpRight,
  ArrowDownRight,
  Settings,
  Terminal,
  Crosshair,
  RefreshCw,
  Coins,
  CheckCircle2,
  XCircle,
  Clock,
  Sparkles,
  Search,
  Globe,
  Wifi,
  Server,
  CheckCircle,
  Info,
  X,
  ArrowLeft,
} from 'lucide-react';
import {
  SocialSignal,
  MemecoinPool,
  SniperPosition,
  SniperBotConfig,
  MemecoinPlatform,
} from '../types';
import { engineClient } from '../services/engineClient';
import { hftAudio } from '../utils/audio';
import { PumpFunHotCalloutsView } from './PumpFunHotCalloutsView';
import { TokenInlineExternalLinks, TokenExternalLinksModal } from './TokenExternalLinksView';

interface MemecoinSocialSniperModalProps {
  isOpen: boolean;
  onClose: () => void;
  capitalTier?: 'MICRO_10' | 'INSTITUTIONAL';
  onAlertTrigger?: (level: 'INFO' | 'WARNING' | 'CRITICAL', title: string, message: string) => void;
}

export const MemecoinSocialSniperModal: React.FC<MemecoinSocialSniperModalProps> = ({
  isOpen,
  onClose,
  capitalTier = 'MICRO_10',
  onAlertTrigger,
}) => {
  const [activeTab, setActiveTab] = useState<'CALLOUTS' | 'SCANNER' | 'AGGREGATOR' | 'SNIPER' | 'TELEGRAM_BOT'>('CALLOUTS');
  
  // Data states
  const [signals, setSignals] = useState<SocialSignal[]>([]);
  const [pools, setPools] = useState<MemecoinPool[]>([]);
  const [positions, setPositions] = useState<SniperPosition[]>([]);
  const [sniperConfig, setSniperConfig] = useState<SniperBotConfig>({
    isAutoSnipeEnabled: false,
    minConfidenceScore: 85,
    defaultSnipeAmountUsd: capitalTier === 'MICRO_10' ? 5.0 : 50.0,
    maxSlippagePct: 8.0,
    jitoTipSol: 0.005,
    takeProfitPct: 50.0,
    stopLossPct: 20.0,
    trailingStopEnabled: true,
    requireMintRevoked: true,
    requireFreezeRevoked: true,
    maxDevHoldingPct: 5.0,
    telegramBotToken: '',
    telegramChatId: '',
    telegramWebhookActive: true,
  });

  // Filters & UI states
  const [selectedPlatform, setSelectedPlatform] = useState<string>('ALL');
  const [selectedChain, setSelectedChain] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [positionSearchQuery, setPositionSearchQuery] = useState<string>('');
  const [copiedCa, setCopiedCa] = useState<string | null>(null);
  const [selectedExternalToken, setSelectedExternalToken] = useState<any>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [manualSnipeCa, setManualSnipeCa] = useState('');
  const [manualSnipeAmount, setManualSnipeAmount] = useState(capitalTier === 'MICRO_10' ? '5.0' : '25.0');
  const [manualSnipeLoading, setManualSnipeLoading] = useState(false);

  // Telegram interactive terminal
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalHistory, setTerminalHistory] = useState<Array<{ sender: 'USER' | 'BOT'; text: string; time: string }>>([
    {
      sender: 'BOT',
      text: '🤖 APEX QUANT TELEGRAM BOT ENGINE ONLINE\nListening to alpha channels and market maker bots on Telegram & X.com.\nType /help or /signals to view intelligence stream.',
      time: new Date().toLocaleTimeString(),
    },
  ]);

  // Real-time external connection testing & diagnostics state
  const [isTestingTelegram, setIsTestingTelegram] = useState(false);
  const [telegramTestResult, setTelegramTestResult] = useState<any | null>(null);
  const [sendPingMsg, setSendPingMsg] = useState(false);
  const [isTestingDiagnostics, setIsTestingDiagnostics] = useState(false);
  const tradingMode = useTradingMode();
  const [diagnosticsResult, setDiagnosticsResult] = useState<any | null>(null);
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false);

  const handleTestTelegram = async () => {
    setIsTestingTelegram(true);
    try {
      const res = await engineClient.testTelegramConnection(
        sniperConfig.telegramBotToken,
        sniperConfig.telegramChatId,
        sendPingMsg
      );
      setTelegramTestResult(res);
      if (res?.reachable) {
        hftAudio.playTradeFill(true);
        onAlertTrigger?.(
          res.botAuthorized ? 'INFO' : 'WARNING',
          res.botAuthorized ? 'TELEGRAM BOT VERIFIED' : 'TELEGRAM REACHABLE (DEMO TOKEN)',
          res.diagnosis
        );
      } else {
        hftAudio.playAlertBeep('CRITICAL');
        onAlertTrigger?.('CRITICAL', 'TELEGRAM UNREACHABLE', res.diagnosis || 'Failed to reach api.telegram.org');
      }
    } catch (e: any) {
      onAlertTrigger?.('CRITICAL', 'CONNECTION ERROR', e.message);
    } finally {
      setIsTestingTelegram(false);
    }
  };

  const handleRunDiagnostics = async () => {
    setIsTestingDiagnostics(true);
    try {
      const res = await engineClient.getConnectivityDiagnostics();
      setDiagnosticsResult(res);
      setShowDiagnosticsModal(true);
      hftAudio.playTradeFill(true);
      onAlertTrigger?.(
        'INFO',
        'CONNECTIVITY AUDIT COMPLETE',
        `Verified ${Object.keys(res?.connections || {}).length} external services & ${res?.marketMakerProfiles?.totalProfiles || 0} market maker profiles.`
      );
    } catch (e: any) {
      onAlertTrigger?.('CRITICAL', 'DIAGNOSTICS ERROR', e.message);
    } finally {
      setIsTestingDiagnostics(false);
    }
  };

  const [isWsLive, setIsWsLive] = useState(engineClient.isWsConnected());

  // Deduplicate pools by CA and ID to guarantee unique React keys
  const deduplicatePools = (poolList: MemecoinPool[]): MemecoinPool[] => {
    const seen = new Set<string>();
    const unique: MemecoinPool[] = [];
    for (const p of poolList) {
      const key = `${p.contractAddress || p.id || ''}`.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        unique.push(p);
      }
    }
    return unique;
  };

  // Load initial data and poll
  const refreshData = async () => {
    setIsRefreshing(true);
    try {
      const sigData = await engineClient.getSocialSignals();
      if (sigData?.signals) setSignals(sigData.signals);

      const poolData = await engineClient.getMemecoinPools(selectedPlatform, selectedChain);
      if (poolData?.pools) setPools(deduplicatePools(poolData.pools));

      const posData = await engineClient.getSniperPositions();
      if (posData?.positions) setPositions(posData.positions);

      const cfgData = await engineClient.getSniperConfig();
      if (cfgData?.config) setSniperConfig(cfgData.config);
    } catch (e) {
      console.error(e);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    refreshData();

    // Subscribe to real-time WebSocket push updates
    const unsubSnapshot = engineClient.onMemecoinSnapshot((data) => {
      setIsWsLive(true);
      if (data.pools) setPools(deduplicatePools(data.pools));
      if (data.positions) setPositions(data.positions);
      if (data.config) setSniperConfig(data.config);
    });

    const unsubTrade = engineClient.onSniperTrade((data) => {
      if (data?.position) {
        onAlertTrigger?.('INFO', '⚡ SNIPER TRADE EXECUTED', data.message || `Snipe filled for ${data.position.tokenTicker}`);
        refreshData();
      }
    });

    const interval = setInterval(() => {
      setIsWsLive(engineClient.isWsConnected());
      refreshData();
    }, 5000);

    return () => {
      unsubSnapshot();
      unsubTrade();
      clearInterval(interval);
    };
  }, [isOpen, selectedPlatform, selectedChain]);

  // Copy CA helper
  const copyToClipboard = (ca: string) => {
    navigator.clipboard.writeText(ca);
    setCopiedCa(ca);
    setTimeout(() => setCopiedCa(null), 2000);
  };

  // Snipe a specific signal
  const handleSnipeSignal = async (sig: SocialSignal) => {
    const amount = capitalTier === 'MICRO_10' ? 5.0 : 25.0;
    // Q10b: while LIVE is armed this click sends a real transaction; say so and ask first
    const warning = liveClickWarning(tradingMode, `Sniping ${sig.tokenTicker} for $${amount.toFixed(2)}`);
    if (warning && !window.confirm(warning)) return;
    hftAudio.playOrderFill();
    const res = await engineClient.snipeSocialSignal(sig.id, amount, sniperConfig.jitoTipSol, sniperConfig.maxSlippagePct, tradingMode.live);
    
    if (res?.tradeResult?.success) {
      onAlertTrigger?.(
        'INFO',
        `SNIPED ${sig.tokenTicker}`,
        `${/^PAPER/i.test(String(res.tradeResult.txHash ?? '')) ? 'Paper fill' : 'Sent'} for $${amount.toFixed(2)} on ${sig.chain}${res.tradeResult.txHash ? ` (${String(res.tradeResult.txHash).slice(0, 14)}...)` : ''}. CA: ${sig.contractAddress.slice(0, 10)}...`
      );
      // Update signal status locally
      setSignals((prev) =>
        prev.map((s) => (s.id === sig.id ? { ...s, status: 'SNIPED' } : s))
      );
      refreshData();
    } else {
      onAlertTrigger?.(
        'WARNING',
        `SNIPE REJECTED`,
        res?.tradeResult?.message || 'Failed pre-trade risk check'
      );
    }
  };

  // Close / Take profit on open position
  const handleClosePosition = async (posId: string, sellPct: number = 100) => {
    hftAudio.playOrderFill();
    const res = await engineClient.closeSniperPosition(posId, sellPct);
    if (res?.result?.success) {
      onAlertTrigger?.(
        'INFO',
        'POSITION CLOSED',
        res.result.message
      );
      refreshData();
    } else {
      // R29: a refused close used to vanish silently
      onAlertTrigger?.('WARNING', 'CLOSE NOT DONE', res?.result?.message || res?.error || 'The server did not close the position.');
    }
  };

  // Send terminal message
  const handleSendTerminal = async () => {
    if (!terminalInput.trim()) return;
    const text = terminalInput.trim();
    const nowStr = new Date().toLocaleTimeString();
    
    setTerminalHistory((prev) => [...prev, { sender: 'USER', text, time: nowStr }]);
    setTerminalInput('');

    const res = await engineClient.sendTelegramWebhookMessage(text);
    if (res?.result?.reply) {
      setTerminalHistory((prev) => [
        ...prev,
        { sender: 'BOT', text: res.result.reply, time: new Date().toLocaleTimeString() },
      ]);
      hftAudio.playAlert();
      refreshData();
    }
  };

  // Manual Snipe by CA
  const handleManualSnipe = async () => {
    if (!manualSnipeCa.trim()) return;
    setManualSnipeLoading(true);
    hftAudio.playOrderFill();
    try {
      const res = await engineClient.executeMemecoinSnipe({
        contractAddress: manualSnipeCa.trim(),
        amountUsd: Number(manualSnipeAmount) || 5.0,
        jitoTipSol: sniperConfig.jitoTipSol,
        slippagePct: sniperConfig.maxSlippagePct,
      });

      if (res?.result?.success) {
        onAlertTrigger?.('INFO', 'MANUAL SNIPE SUCCESSFUL', res.result.message);
        setManualSnipeCa('');
        refreshData();
      } else {
        onAlertTrigger?.('WARNING', 'SNIPE REJECTED', res?.result?.message || 'Rejected');
      }
    } finally {
      setManualSnipeLoading(false);
    }
  };

  if (!isOpen) return null;

  // Filtered pools
  const filteredPools = pools.filter((p) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        p.symbol.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.contractAddress.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="fixed top-16 inset-x-0 bottom-0 z-40 flex items-start justify-center bg-black/85 backdrop-blur-md p-2 sm:p-4 overflow-y-auto">
      <div className="relative w-full max-w-7xl bg-[#0B101D] border border-[#1E293B] rounded-2xl shadow-2xl flex flex-col my-2 sm:my-3 text-slate-200">
        {/* HEADER BAR */}
        <div className="px-5 py-4 border-b border-[#1E293B] bg-[#0E1526] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/20 border border-cyan-500/40 text-cyan-400">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-base sm:text-lg font-bold text-white tracking-wide">
                  Telegram & X Market Maker Intelligence & Memecoin Sniper Swarm
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center space-x-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                  <span>LIVE INGESTION</span>
                </span>
                {isWsLive && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 flex items-center space-x-1">
                    <Radio className="w-3 h-3 text-cyan-400 animate-pulse" />
                    <span>WS STREAMING</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Aggregating Pump.fun, Raydium, DexScreener, Uniswap/Base with automated Jito MEV bundle execution.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Capital Tier Pill */}
            <div className="px-2.5 py-1 rounded-lg bg-amber-950/60 border border-amber-500/40 text-amber-300 text-xs font-mono flex items-center space-x-1.5">
              <Coins className="w-3.5 h-3.5" />
              <span>{capitalTier === 'MICRO_10' ? '$10 Micro Account' : '$500k Inst Tier'}</span>
            </div>

            {/* Run Outside World Diagnostics Button */}
            <button
              onClick={handleRunDiagnostics}
              disabled={isTestingDiagnostics}
              className="px-2.5 py-1.5 rounded-lg bg-cyan-950/60 hover:bg-cyan-900/60 border border-cyan-500/40 text-cyan-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition active:scale-95"
              title="Verify live outbound network connections & audit simulation boundaries"
            >
              <Globe className={`w-3.5 h-3.5 ${isTestingDiagnostics ? 'animate-spin text-cyan-400' : 'text-cyan-400'}`} />
              <span className="hidden sm:inline">Audit Connections</span>
            </button>

            <button
              onClick={refreshData}
              disabled={isRefreshing}
              className="p-2 rounded-lg bg-[#141B2D] border border-[#1E293B] text-slate-300 hover:text-white hover:bg-slate-800 transition"
              title="Refresh Data"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
            </button>

            {/* Back to Workstation Button */}
            <button
              id="btn-return-workstation-from-sniper"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-blue-600/40 to-cyan-600/40 hover:from-blue-600/60 hover:to-cyan-600/60 text-cyan-200 text-xs font-bold transition border border-cyan-500/40 flex items-center space-x-1.5"
              title="Return to Main HFT Workstation Dashboard"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Workstation</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-bold transition border border-slate-700"
              title="Close modal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* METRIC STRIP */}
        <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-[#1E293B] bg-[#0A0E1A] text-xs font-mono">
          <div className="p-3 border-r border-[#1E293B] flex items-center justify-between">
            <span className="text-slate-400 flex items-center space-x-1.5">
              <Send className="w-3.5 h-3.5 text-blue-400" />
              <span>Alpha Signals Detected</span>
            </span>
            <span className="font-bold text-cyan-300">{signals.length} Live</span>
          </div>
          <div className="p-3 border-r border-[#1E293B] flex items-center justify-between">
            <span className="text-slate-400 flex items-center space-x-1.5">
              <Layers className="w-3.5 h-3.5 text-amber-400" />
              <span>Monitored Pools</span>
            </span>
            <span className="font-bold text-amber-300">{pools.length} Cross-DEX</span>
          </div>
          <div className="p-3 border-r border-[#1E293B] flex items-center justify-between">
            <span className="text-slate-400 flex items-center space-x-1.5">
              <Crosshair className="w-3.5 h-3.5 text-emerald-400" />
              <span>Open Sniper Positions</span>
            </span>
            <span className="font-bold text-emerald-400">{positions.filter(p => p.status === 'OPEN').length} Active</span>
          </div>
          <div className="p-3 flex items-center justify-between">
            <span className="text-slate-400 flex items-center space-x-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-purple-400" />
              <span>Jito MEV Protection</span>
            </span>
            <span className="font-bold text-purple-300">0.005 SOL Tip (Direct Slot)</span>
          </div>
        </div>

        {/* NAVIGATION TABS */}
        <div className="flex border-b border-[#1E293B] bg-[#0E1526] px-5 overflow-x-auto">
          <button
            onClick={() => setActiveTab('CALLOUTS')}
            className={`px-4 py-3 text-xs font-mono font-bold flex items-center space-x-2 border-b-2 transition flex-shrink-0 ${
              activeTab === 'CALLOUTS'
                ? 'border-rose-500 text-rose-300 bg-rose-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Flame className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
            <span>Pump.fun Hot Callouts</span>
            <span className="px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 text-[10px] font-bold border border-rose-500/40">
              HOT 🔥
            </span>
          </button>

          <button
            onClick={() => setActiveTab('SCANNER')}
            className={`px-4 py-3 text-xs font-mono font-bold flex items-center space-x-2 border-b-2 transition flex-shrink-0 ${
              activeTab === 'SCANNER'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Send className="w-3.5 h-3.5" />
            <span>Telegram & X Intelligence Stream</span>
            <span className="px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 text-[10px]">
              {signals.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('AGGREGATOR')}
            className={`px-4 py-3 text-xs font-mono font-bold flex items-center space-x-2 border-b-2 transition flex-shrink-0 ${
              activeTab === 'AGGREGATOR'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            <span>Multi-Platform Memecoin Aggregator</span>
            <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 text-[10px]">
              {pools.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('SNIPER')}
            className={`px-4 py-3 text-xs font-mono font-bold flex items-center space-x-2 border-b-2 transition flex-shrink-0 ${
              activeTab === 'SNIPER'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            <span>Autonomous Sniper & Positions</span>
            {positions.filter((p) => p.status === 'OPEN').length > 0 && (
              <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 text-[10px] animate-pulse">
                {positions.filter((p) => p.status === 'OPEN').length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('TELEGRAM_BOT')}
            className={`px-4 py-3 text-xs font-mono font-bold flex items-center space-x-2 border-b-2 transition flex-shrink-0 ${
              activeTab === 'TELEGRAM_BOT'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5 text-purple-400" />
            <span>Telegram Bot Control Hub</span>
          </button>
        </div>

        {/* TAB BODY CONTENT */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* ========================================================================= */}
          {/* TAB 0: PUMP.FUN HOT CALLOUTS & CALLER LEADERBOARD */}
          {/* ========================================================================= */}
          {activeTab === 'CALLOUTS' && (
            <PumpFunHotCalloutsView
              capitalTier={capitalTier}
              onAlertTrigger={onAlertTrigger}
              onRefreshParent={refreshData}
            />
          )}
          {/* ========================================================================= */}
          {/* TAB 1: SOCIAL SCANNER (TELEGRAM & X.COM) */}
          {/* ========================================================================= */}
          {activeTab === 'SCANNER' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-[#12192C] border border-[#1E293B]">
                <div className="flex items-center space-x-2 text-xs">
                  <span className="text-slate-400">Filter Source:</span>
                  <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono text-[11px] border border-blue-500/30">
                    Telegram Alpha Channels
                  </span>
                  <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px] border border-slate-700">
                    X.com KOLs & Smart Money
                  </span>
                </div>
                <div className="text-xs text-slate-400 font-mono">
                  Autonomous Snipe Threshold: <strong className="text-emerald-400">&gt;={sniperConfig.minConfidenceScore}% Confidence</strong>
                </div>
              </div>

              {/* Signals Feed */}
              <div className="grid grid-cols-1 gap-3">
                {signals.map((sig, sIdx) => {
                  const isTelegram = sig.source === 'TELEGRAM';
                  const isHighConf = sig.confidenceScore !== null && sig.confidenceScore >= 90;

                  return (
                    <div
                      key={`sig-${sig.id}-${sig.contractAddress || ''}-${sIdx}`}
                      className={`p-4 rounded-xl border transition flex flex-col space-y-3 ${
                        sig.status === 'SNIPED'
                          ? 'bg-[#0F1B2B] border-emerald-500/50'
                          : 'bg-[#101728] border-[#1E293B] hover:border-slate-600'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center space-x-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center space-x-1 ${
                              isTelegram
                                ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                                : 'bg-slate-800 text-slate-200 border border-slate-700'
                            }`}
                          >
                            <Send className="w-3 h-3" />
                            <span>{sig.source}</span>
                          </span>

                          <span className="font-bold text-white text-xs sm:text-sm">
                            {sig.authorDisplayName}
                          </span>
                          <span className="text-slate-400 text-xs font-mono">{sig.authorHandle}</span>

                          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-purple-500/20 text-purple-300 border border-purple-500/40">
                            {sig.signalPattern.replace('_', ' ')}
                          </span>
                        </div>

                        <div className="flex items-center space-x-3 text-xs font-mono">
                          <span className="text-slate-400 flex items-center space-x-1">
                            <Clock className="w-3 h-3" />
                            <span>{sig.timeStr}</span>
                          </span>

                          <span
                            className={`px-2 py-0.5 rounded font-bold ${
                              isHighConf
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            }`}
                          >
                            Confidence: {sig.confidenceScore === null ? 'not scored' : `${sig.confidenceScore}%`}
                          </span>
                        </div>
                      </div>

                      {/* Raw Post Text */}
                      <p className="text-xs sm:text-sm text-slate-200 leading-relaxed font-sans bg-[#0A0F1D] p-3 rounded-lg border border-[#172033]">
                        {sig.rawText}
                      </p>

                      {/* Token metadata strip & Snipe button */}
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs font-mono">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="flex items-center space-x-1.5">
                            <span className="text-slate-400">Token:</span>
                            <span className="font-bold text-cyan-300 text-sm">{sig.tokenTicker}</span>
                            <span className="text-slate-500">({sig.tokenName})</span>
                          </div>

                          <div className="flex items-center space-x-1 bg-[#141B2D] px-2 py-1 rounded border border-[#1E293B]">
                            <span className="text-slate-400">CA:</span>
                            <span className="text-slate-300 font-mono">
                              {sig.contractAddress.slice(0, 8)}...{sig.contractAddress.slice(-6)}
                            </span>
                            <button
                              onClick={() => copyToClipboard(sig.contractAddress)}
                              className="text-slate-400 hover:text-white ml-1"
                              title="Copy Contract Address"
                            >
                              {copiedCa === sig.contractAddress ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                          </div>

                          {sig.liquidityUsd && (
                            <span className="text-slate-400">
                              Liquidity: <strong className="text-slate-200">${sig.liquidityUsd.toLocaleString()}</strong>
                            </span>
                          )}

                          {/* Live Platform Feed Links */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            {/* Pump.fun Link */}
                            <a
                              href={`https://pump.fun/coin/${sig.contractAddress}`}
                              target="_blank"
                              rel="noreferrer"
                              className="px-2 py-0.5 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[10px] font-mono flex items-center space-x-1 transition"
                              title="Open on Pump.fun"
                            >
                              <Flame className="w-2.5 h-2.5 text-rose-400" />
                              <span>Pump.fun</span>
                              <ExternalLink className="w-2 h-2 text-rose-400" />
                            </a>

                            {/* DexScreener Link */}
                            <a
                              href={`https://dexscreener.com/solana/${sig.contractAddress}`}
                              target="_blank"
                              rel="noreferrer"
                              className="px-2 py-0.5 rounded bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-[10px] font-mono flex items-center space-x-1 transition"
                              title="View Chart on DexScreener"
                            >
                              <TrendingUp className="w-2.5 h-2.5 text-cyan-400" />
                              <span>DexScreener</span>
                              <ExternalLink className="w-2 h-2 text-cyan-400" />
                            </a>

                            {/* X.com Link */}
                            <a
                              href={
                                sig.socials?.twitter ||
                                (sig.source === 'X_TWITTER' && sig.authorHandle.startsWith('@')
                                  ? `https://x.com/${sig.authorHandle.replace('@', '')}`
                                  : `https://x.com/search?q=%24${sig.tokenTicker.replace('$', '')}+solana`)
                              }
                              target="_blank"
                              rel="noreferrer"
                              className="px-2 py-0.5 rounded bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 text-[10px] font-mono flex items-center space-x-1 transition"
                              title={
                                sig.socials?.twitter
                                  ? `Verified Token X Feed: ${sig.socials.twitter}`
                                  : sig.source === 'X_TWITTER'
                                  ? `View Author @${sig.authorHandle} on X`
                                  : `Search $${sig.tokenTicker} on X.com`
                              }
                            >
                              <span className="font-bold text-[11px]">𝕏</span>
                              <span>{sig.socials?.twitter ? 'Token 𝕏' : sig.source === 'X_TWITTER' ? 'KOL 𝕏' : 'Search 𝕏'}</span>
                              <ExternalLink className="w-2 h-2 text-sky-400" />
                            </a>

                            {/* Telegram Link */}
                            {(sig.socials?.telegram || sig.source === 'TELEGRAM') && (
                              <a
                                href={
                                  sig.socials?.telegram ||
                                  (sig.authorHandle.startsWith('@') || !sig.authorHandle.includes(' ')
                                    ? `https://t.me/${sig.authorHandle.replace('@', '')}`
                                    : `https://t.me/pumpfun_channel`)
                                }
                                target="_blank"
                                rel="noreferrer"
                                className="px-2 py-0.5 rounded bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[10px] font-mono flex items-center space-x-1 transition"
                                title={
                                  sig.socials?.telegram
                                    ? `Verified Telegram Channel: ${sig.socials.telegram}`
                                    : `Open Channel on Telegram`
                                }
                              >
                                <Send className="w-2.5 h-2.5 text-blue-400" />
                                <span>Telegram</span>
                                <ExternalLink className="w-2 h-2 text-blue-400" />
                              </a>
                            )}

                            {/* Live Ingestion Indicator */}
                            {sig.isLiveFeed && (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center space-x-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                <span>LIVE</span>
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center space-x-2">
                          {sig.status === 'SNIPED' ? (
                            <span className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs font-bold flex items-center space-x-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>SNIPED IN BLOCK SLOT</span>
                            </span>
                          ) : (
                            <button
                              onClick={() => handleSnipeSignal(sig)}
                              className="px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs shadow-md shadow-emerald-950/40 flex items-center space-x-1.5 transition active:scale-95"
                            >
                              <Zap className="w-3.5 h-3.5" />
                              <span>Snipe with {capitalTier === 'MICRO_10' ? '$5 Micro' : '$25'} ({tradingMode.label})</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 2: MULTI-PLATFORM MEMECOIN AGGREGATOR */}
          {/* ========================================================================= */}
          {activeTab === 'AGGREGATOR' && (
            <div className="space-y-4">
              {/* FILTERS & SEARCH */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-[#12192C] border border-[#1E293B]">
                {/* Platform selector */}
                <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
                  <span className="text-slate-400 mr-1">Platform:</span>
                  {['ALL', 'PUMP_FUN', 'RAYDIUM', 'DEXSCREENER', 'UNISWAP_BASE'].map((plat) => (
                    <button
                      key={plat}
                      onClick={() => setSelectedPlatform(plat)}
                      className={`px-2.5 py-1 rounded text-[11px] font-bold transition ${
                        selectedPlatform === plat
                          ? 'bg-cyan-500 text-black shadow'
                          : 'bg-[#141B2D] text-slate-300 hover:text-white border border-[#1E293B]'
                      }`}
                    >
                      {plat.replace('_', '.')}
                    </button>
                  ))}
                </div>

                {/* Search Bar */}
                <div className="relative min-w-[220px]">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    placeholder="Search ticker, name, or CA..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-[#141B2D] border border-[#1E293B] rounded-lg pl-8 pr-3 py-1.5 text-xs text-white outline-none focus:border-cyan-400 font-mono"
                  />
                </div>
              </div>

              {/* MEMECOIN TOKENS TABLE */}
              <div className="overflow-x-auto rounded-xl border border-[#1E293B] bg-[#0E1526]">
                <table className="w-full text-left text-xs font-mono border-collapse">
                  <thead>
                    <tr className="border-b border-[#1E293B] bg-[#0A0F1D] text-slate-400">
                      <th className="p-3">Rank / Token</th>
                      <th className="p-3">Platform & Chain</th>
                      <th className="p-3">Price / 5m Chg</th>
                      <th className="p-3">Bonding Curve Progress</th>
                      <th className="p-3">Liquidity / MC</th>
                      <th className="p-3">5m Volume & Buys</th>
                      <th className="p-3">RugCheck Security</th>
                      <th className="p-3 text-right">Instant Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#172033]">
                    {filteredPools.map((pool, pIdx) => {
                      const isPositive = pool.priceChange5mPct >= 0;
                      const hasBonding = !pool.isMigrated && pool.bondingCurveProgress !== undefined && pool.bondingCurveProgress < 100;

                      return (
                        <tr key={`pool-${pool.id}-${pool.contractAddress || ''}-${pIdx}`} className="hover:bg-[#12192C] transition">
                          {/* Token Name & CA */}
                          <td className="p-3">
                            <div className="flex items-center space-x-2">
                              <span className="text-slate-500 font-bold">#{pool.trendingRank}</span>
                              <div>
                                <div className="font-bold text-white text-sm flex items-center space-x-1">
                                  <span>${pool.symbol}</span>
                                  <span className="text-slate-400 text-xs font-normal">({pool.name})</span>
                                </div>
                                <div className="text-[10px] text-slate-400 flex items-center space-x-1">
                                  <span>{pool.contractAddress.slice(0, 6)}...{pool.contractAddress.slice(-4)}</span>
                                  <button onClick={() => copyToClipboard(pool.contractAddress)}>
                                    {copiedCa === pool.contractAddress ? (
                                      <Check className="w-2.5 h-2.5 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-2.5 h-2.5" />
                                    )}
                                  </button>
                                </div>
                                <TokenInlineExternalLinks
                                  mintOrCa={pool.contractAddress}
                                  symbol={pool.symbol}
                                  name={pool.name}
                                  chain={pool.chain}
                                  platform={pool.platform}
                                  compact={true}
                                  onOpenModal={() =>
                                    setSelectedExternalToken({
                                      mintOrCa: pool.contractAddress,
                                      symbol: pool.symbol,
                                      name: pool.name,
                                      chain: pool.chain,
                                      platform: pool.platform,
                                      priceUsd: pool.priceUsd,
                                    })
                                  }
                                />
                              </div>
                            </div>
                          </td>

                          {/* Platform & Chain */}
                          <td className="p-3">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#141B2D] border border-[#1E293B] text-slate-300">
                              {pool.platform.replace('_', ' ')}
                            </span>
                            <div className="text-[10px] text-cyan-400 mt-0.5">{pool.chain}</div>
                          </td>

                          {/* Price & Change */}
                          <td className="p-3">
                            <div className="font-bold text-slate-200">
                              ${pool.priceUsd < 0.001 ? pool.priceUsd.toFixed(6) : pool.priceUsd.toFixed(4)}
                            </div>
                            <div className={`text-[11px] font-bold flex items-center space-x-0.5 ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                              <span>{isPositive ? '+' : ''}{pool.priceChange5mPct}% (5m)</span>
                            </div>
                          </td>

                          {/* Bonding Curve */}
                          <td className="p-3">
                            {hasBonding ? (
                              <div className="w-32">
                                <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                                  <span>Curve</span>
                                  <span className="font-bold text-amber-300">{pool.bondingCurveProgress?.toFixed(1)}%</span>
                                </div>
                                <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                                  <div
                                    className="h-full bg-gradient-to-r from-amber-500 to-emerald-400"
                                    style={{ width: `${pool.bondingCurveProgress}%` }}
                                  ></div>
                                </div>
                              </div>
                            ) : (
                              pool.isMigrated || (pool.bondingCurveProgress ?? 0) >= 100 ? (
                                <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                  🎓 Raydium Migrated
                                </span>
                              ) : (
                                <span className="text-slate-500 text-[10px]">curve progress unknown</span>
                              )
                            )}
                          </td>

                          {/* Liquidity / Market Cap */}
                          <td className="p-3">
                            <div className="text-slate-200 font-bold">${pool.marketCapUsd.toLocaleString()} MC</div>
                            <div className="text-slate-400 text-[10px]">Liq: ${pool.liquidityUsd.toLocaleString()}</div>
                          </td>

                          {/* Volume & Buys */}
                          <td className="p-3">
                            <div className="text-slate-300 font-bold">${pool.volume5mUsd.toLocaleString()}</div>
                            <div className="text-[10px] text-emerald-400">
                              {pool.buys5m} Buys / {pool.sells5m} Sells
                            </div>
                          </td>

                          {/* RugCheck Security */}
                          <td className="p-3">
                            <div className="space-y-0.5 text-[10px]">
                              {([['Mint', pool.authoritiesVerified === false ? null : pool.isMintRevoked], ['Freeze', pool.authoritiesVerified === false ? null : pool.isFreezeRevoked]] as const).map(([kind, v]) => {
                                const b = authorityBadge(kind, v);
                                return (
                                  <div key={kind} className={`flex items-center space-x-1 ${authorityTone[b.tone]}`}>
                                    <CheckCircle2 className="w-3 h-3" />
                                    <span>{b.text}</span>
                                  </div>
                                );
                              })}
                              <div className="text-slate-400">
                                Top 10: <strong className="text-slate-200">{holderPct(pool.top10HoldersPct)}</strong>
                              </div>
                            </div>
                          </td>

                          {/* Action */}
                          <td className="p-3 text-right">
                            <button
                              onClick={() => {
                                handleSnipeSignal({
                                  id: `sig-agg-${pool.id}`,
                                  provenance: pool.id.startsWith('pool-onchain') ? 'REAL_ONCHAIN' : 'SYNTHETIC_TEST',
                                  source: 'TELEGRAM',
                                  authorHandle: pool.platform,
                                  authorDisplayName: pool.name,
                                  authorTier: 'MARKET_MAKER_BOT',
                                  verified: false,
                                  timestamp: Date.now(),
                                  timeStr: 'Now',
                                  rawText: `Manual snipe of ${pool.symbol} from the ${pool.platform} pool list (operator-initiated, no signal scoring)`,
                                  tokenTicker: `$${pool.symbol}`,
                                  tokenName: pool.name,
                                  contractAddress: pool.contractAddress,
                                  chain: pool.chain,
                                  signalPattern: 'STEALTH_ACCUMULATION',
                                  confidenceScore: null,
                                  sentimentScore: null,
                                  actionSuggested: 'REVIEW',
                                  status: 'NEW',
                                  metrics: {},
                                });
                              }}
                              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow transition active:scale-95 flex items-center space-x-1 ml-auto"
                            >
                              <Zap className="w-3 h-3" />
                              <span>Snipe ${capitalTier === 'MICRO_10' ? '5.00' : '25.00'}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 3: AUTONOMOUS SNIPER & OPEN POSITIONS */}
          {/* ========================================================================= */}
          {activeTab === 'SNIPER' && (
            <div className="space-y-5">
              {/* AUTONOMOUS SNIPER CONFIG PANEL */}
              <div className="p-4 rounded-xl bg-[#12192C] border border-[#1E293B] space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1E293B] pb-3">
                  <div className="flex items-center space-x-2">
                    <Bot className="w-5 h-5 text-cyan-400" />
                    <div>
                      <h3 className="text-sm font-bold text-white">Autonomous Social & MM Sniper Swarm</h3>
                      <p className="text-xs text-slate-400">
                        Automatically executes trades across Pump.fun, Raydium, and Base when social signals meet criteria.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <span className="text-xs font-mono text-slate-300">Auto-Sniper:</span>
                    <button
                      onClick={async () => {
                        const next = !sniperConfig.isAutoSnipeEnabled;
                        setSniperConfig({ ...sniperConfig, isAutoSnipeEnabled: next });
                        await engineClient.updateSniperConfig({ isAutoSnipeEnabled: next });
                      }}
                      className={`px-3 py-1 rounded-full text-xs font-bold font-mono transition ${
                        sniperConfig.isAutoSnipeEnabled
                          ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/30'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}
                    >
                      {sniperConfig.isAutoSnipeEnabled ? 'ARMED & ACTIVE' : 'DISARMED'}
                    </button>
                  </div>
                </div>

                {/* Configuration Inputs */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                  <div>
                    <label className="block text-slate-400 text-[10px] mb-1">
                      Min Confidence Score
                    </label>
                    <input
                      type="number"
                      min="50"
                      max="100"
                      value={sniperConfig.minConfidenceScore}
                      onChange={(e) =>
                        setSniperConfig({ ...sniperConfig, minConfidenceScore: Number(e.target.value) })
                      }
                      className="w-full bg-[#141B2D] border border-[#1E293B] rounded p-2 text-white font-mono outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 text-[10px] mb-1">
                      Snipe Amount (USD)
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      value={sniperConfig.defaultSnipeAmountUsd}
                      onChange={(e) =>
                        setSniperConfig({ ...sniperConfig, defaultSnipeAmountUsd: Number(e.target.value) })
                      }
                      className="w-full bg-[#141B2D] border border-[#1E293B] rounded p-2 text-white font-mono outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 text-[10px] mb-1">
                      Jito MEV Tip (SOL)
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      value={sniperConfig.jitoTipSol}
                      onChange={(e) =>
                        setSniperConfig({ ...sniperConfig, jitoTipSol: Number(e.target.value) })
                      }
                      className="w-full bg-[#141B2D] border border-[#1E293B] rounded p-2 text-white font-mono outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 text-[10px] mb-1">
                      Take-Profit Target (%)
                    </label>
                    <input
                      type="number"
                      value={sniperConfig.takeProfitPct}
                      onChange={(e) =>
                        setSniperConfig({ ...sniperConfig, takeProfitPct: Number(e.target.value) })
                      }
                      className="w-full bg-[#141B2D] border border-[#1E293B] rounded p-2 text-white font-mono outline-none focus:border-cyan-400"
                    />
                  </div>
                </div>
              </div>

              {/* MANUAL SNIPE BY CONTRACT ADDRESS BAR */}
              <div className="p-4 rounded-xl bg-[#101728] border border-[#1E293B] flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[260px]">
                  <label className="block text-slate-400 text-xs font-mono mb-1">
                    Manual Contract Address Sniper (Solana Base58 or Base 0x...)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS"
                    value={manualSnipeCa}
                    onChange={(e) => setManualSnipeCa(e.target.value)}
                    className="w-full bg-[#141B2D] border border-[#1E293B] rounded-lg px-3 py-2 text-xs text-white font-mono outline-none focus:border-cyan-400"
                  />
                </div>

                <div className="w-28">
                  <label className="block text-slate-400 text-xs font-mono mb-1">Amount ($)</label>
                  <input
                    type="number"
                    value={manualSnipeAmount}
                    onChange={(e) => setManualSnipeAmount(e.target.value)}
                    className="w-full bg-[#141B2D] border border-[#1E293B] rounded-lg px-3 py-2 text-xs text-white font-mono outline-none focus:border-cyan-400"
                  />
                </div>

                <button
                  onClick={handleManualSnipe}
                  disabled={manualSnipeLoading || !manualSnipeCa}
                  className="px-5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black font-bold text-xs font-mono flex items-center space-x-1.5 transition active:scale-95"
                >
                  <Zap className="w-4 h-4" />
                  <span>{manualSnipeLoading ? 'Sniping...' : 'Instant Snipe'}</span>
                </button>
              </div>

              {/* ACTIVE POSITIONS TABLE */}
              {(() => {
                const filteredPositions = positions.filter((pos) => {
                  if (!positionSearchQuery.trim()) return true;
                  const q = positionSearchQuery.toLowerCase().trim();
                  const ticker = (pos.tokenTicker || '').toLowerCase();
                  const ca = (pos.contractAddress || '').toLowerCase();
                  const chain = (pos.chain || '').toLowerCase();
                  const platform = (pos.platform || '').toLowerCase();
                  return ticker.includes(q) || ca.includes(q) || chain.includes(q) || platform.includes(q);
                });

                return (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-slate-300">
                      <div className="flex items-center space-x-2">
                        <span className="font-bold uppercase tracking-wider flex items-center space-x-1.5">
                          <Crosshair className="w-4 h-4 text-emerald-400" />
                          <span>Active Sniper Holdings &amp; Real-Time P&amp;L</span>
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold">
                          {positions.length} Open
                        </span>
                      </div>

                      {/* Position Search Input */}
                      <div className="flex items-center space-x-3">
                        <div className="relative min-w-[240px]">
                          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            placeholder="Search positions by ticker, CA..."
                            value={positionSearchQuery}
                            onChange={(e) => setPositionSearchQuery(e.target.value)}
                            className="w-full bg-[#141B2D] border border-[#1E293B] rounded-lg pl-8 pr-7 py-1 text-xs text-white font-mono placeholder:text-slate-500 outline-none focus:border-cyan-400"
                          />
                          {positionSearchQuery && (
                            <button
                              onClick={() => setPositionSearchQuery('')}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                              title="Clear search"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <span className="text-slate-500 hidden sm:inline text-[11px]">
                          Auto TP: +{sniperConfig.takeProfitPct}% | Auto SL: -{sniperConfig.stopLossPct}%
                        </span>
                      </div>
                    </div>

                    {positions.length === 0 ? (
                      <div className="p-8 text-center text-slate-500 border border-[#1E293B] rounded-xl bg-[#0E1526] text-xs font-mono">
                        No active sniper positions. Use manual snipe or enable Autonomous Sniper to auto-enter high-conviction signals.
                      </div>
                    ) : filteredPositions.length === 0 ? (
                      <div className="p-8 text-center text-slate-400 border border-[#1E293B] rounded-xl bg-[#0E1526] text-xs font-mono space-y-2">
                        <p>No open positions match &ldquo;<span className="text-cyan-400 font-bold">{positionSearchQuery}</span>&rdquo;</p>
                        <button
                          onClick={() => setPositionSearchQuery('')}
                          className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] font-bold border border-slate-700"
                        >
                          Reset Position Search Filter
                        </button>
                      </div>
                    ) : (
                      <div className="overflow-x-auto rounded-xl border border-[#1E293B] bg-[#0E1526]">
                        <table className="w-full text-left text-xs font-mono">
                          <thead>
                            <tr className="border-b border-[#1E293B] bg-[#0A0F1D] text-slate-400">
                              <th className="p-3">Token & External Explorers</th>
                              <th className="p-3">Platform</th>
                              <th className="p-3">Entry Price</th>
                              <th className="p-3">Current Price</th>
                              <th className="p-3">Position Value</th>
                              <th className="p-3">Unrealized PnL</th>
                              <th className="p-3 text-right">Emergency Exit</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#172033]">
                            {filteredPositions.map((pos, posIdx) => {
                              const isProfitable = pos.unrealizedPnlUsd >= 0;
                              return (
                                <tr key={`pos-${pos.id}-${pos.contractAddress || ''}-${posIdx}`} className="hover:bg-[#12192C] transition">
                                  <td className="p-3 font-bold text-white min-w-[240px]">
                                    <div className="flex flex-col space-y-1">
                                      <div className="flex items-center space-x-1.5">
                                        <span className="text-white text-sm font-bold tracking-wide">${pos.tokenTicker}</span>
                                        {pos.tokenName && (
                                          <span className="text-slate-400 text-xs font-normal">({pos.tokenName})</span>
                                        )}
                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-800/80 text-cyan-300 border border-slate-700">
                                          {pos.chain}
                                        </span>
                                      </div>

                                      {pos.contractAddress && (
                                        <span className="text-[10px] text-slate-500 font-normal font-mono truncate max-w-[210px] block">
                                          {pos.contractAddress}
                                        </span>
                                      )}

                                      {/* External Website Direct Launchers (DexScreener, Pump.fun, Birdeye, Solscan, Photon) */}
                                      <TokenInlineExternalLinks
                                        mintOrCa={pos.contractAddress}
                                        symbol={pos.tokenTicker}
                                        name={pos.tokenName}
                                        chain={pos.chain}
                                        platform={pos.platform}
                                        onOpenModal={() =>
                                          setSelectedExternalToken({
                                            mintOrCa: pos.contractAddress,
                                            symbol: pos.tokenTicker,
                                            name: pos.tokenName,
                                            chain: pos.chain,
                                            platform: pos.platform,
                                            priceUsd: pos.currentPriceUsd,
                                            unrealizedPnlPct: pos.unrealizedPnlPct,
                                          })
                                        }
                                      />
                                    </div>
                                  </td>
                                  <td className="p-3 text-slate-300">{pos.platform}</td>
                                  <td className="p-3 text-slate-300">${(pos.entryPriceUsd ?? 0).toFixed(6)}</td>
                                  <td className="p-3 font-bold text-cyan-300">${(pos.currentPriceUsd ?? 0).toFixed(6)}</td>
                                  <td className="p-3 text-slate-200">
                                    ${(pos.currentValueUsd ?? 0).toFixed(2)}{' '}
                                    <span className="text-slate-500 text-[10px]">(${(pos.costBasisUsd ?? 0).toFixed(2)} cost)</span>
                                  </td>
                                  <td className="p-3">
                                    <span
                                      className={`font-bold px-2 py-0.5 rounded ${
                                        isProfitable
                                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                          : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                      }`}
                                    >
                                      {isProfitable ? '+' : ''}${(pos.unrealizedPnlUsd ?? 0).toFixed(2)} ({isProfitable ? '+' : ''}{(pos.unrealizedPnlPct ?? 0).toFixed(1)}%)
                                    </span>
                                  </td>
                                  <td className="p-3 text-right space-x-1.5">
                                    <button
                                      onClick={() => handleClosePosition(pos.id, 50)}
                                      className="px-2 py-1 rounded bg-amber-600/30 hover:bg-amber-600/50 text-amber-300 border border-amber-500/40 text-[11px] font-bold"
                                    >
                                      Take 50%
                                    </button>
                                    <button
                                      onClick={() => handleClosePosition(pos.id, 100)}
                                      className="px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold shadow"
                                    >
                                      Dump 100%
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 4: TELEGRAM BOT INTERACTIVE TERMINAL & WEBHOOK HUB */}
          {/* ========================================================================= */}
          {activeTab === 'TELEGRAM_BOT' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* INTERACTIVE TELEGRAM CHAT EMULATOR */}
              <div className="lg:col-span-8 flex flex-col h-[480px] bg-[#0A0E1A] border border-[#1E293B] rounded-xl overflow-hidden font-mono">
                <div className="p-3 bg-[#0E1526] border-b border-[#1E293B] flex items-center justify-between">
                  <div className="flex items-center space-x-2 text-xs">
                    <Send className="w-4 h-4 text-blue-400" />
                    <span className="font-bold text-white">@ApexQuantHftSniperBot (Telegram Webhook Stream)</span>
                  </div>
                  <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                    STATUS: POLLING ACTIVE
                  </span>
                </div>

                {/* Messages View */}
                <div className="flex-1 p-4 overflow-y-auto space-y-3 text-xs">
                  {terminalHistory.map((item, idx) => (
                    <div
                      key={idx}
                      className={`flex flex-col ${
                        item.sender === 'USER' ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div className="text-[10px] text-slate-500 mb-0.5">
                        {item.sender === 'USER' ? 'You' : 'Apex Telegram Bot'} • {item.time}
                      </div>
                      <div
                        className={`p-3 rounded-xl max-w-[85%] whitespace-pre-line leading-relaxed ${
                          item.sender === 'USER'
                            ? 'bg-blue-600 text-white rounded-br-none'
                            : 'bg-[#141B2D] text-slate-200 border border-[#1E293B] rounded-bl-none'
                        }`}
                      >
                        {item.text}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Command Input Bar */}
                <div className="p-3 bg-[#0E1526] border-t border-[#1E293B] flex items-center space-x-2">
                  <input
                    type="text"
                    placeholder="Type /snipe <CA> or /signals or /help..."
                    value={terminalInput}
                    onChange={(e) => setTerminalInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendTerminal()}
                    className="flex-1 bg-[#141B2D] border border-[#1E293B] rounded-lg px-3 py-2 text-xs text-white font-mono outline-none focus:border-cyan-400"
                  />
                  <button
                    onClick={handleSendTerminal}
                    className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold transition active:scale-95"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* BOT SETTINGS & WEBHOOK DETAILS */}
              <div className="lg:col-span-4 space-y-4">
                <div className="p-4 rounded-xl bg-[#101728] border border-[#1E293B] space-y-3 text-xs font-mono">
                  <h4 className="font-bold text-white flex items-center space-x-1.5">
                    <Settings className="w-4 h-4 text-cyan-400" />
                    <span>Telegram API Credentials</span>
                  </h4>
                  <p className="text-slate-400 text-[11px]">
                    Connect your private BotFather token to broadcast instant pump and migration alerts to your private channel.
                  </p>

                  <div>
                    <label className="block text-slate-400 text-[10px] mb-1">Bot Token</label>
                    <input
                      type="password"
                      placeholder="Enter Bot Token from @BotFather..."
                      value={sniperConfig.telegramBotToken}
                      onChange={(e) =>
                        setSniperConfig({ ...sniperConfig, telegramBotToken: e.target.value })
                      }
                      className="w-full bg-[#141B2D] border border-[#1E293B] rounded p-2 text-slate-300 text-xs font-mono outline-none focus:border-cyan-500/50"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 text-[10px] mb-1">Alert Channel / Chat ID</label>
                    <input
                      type="text"
                      placeholder="e.g. @apex_alpha_vip_snipers or chat ID"
                      value={sniperConfig.telegramChatId}
                      onChange={(e) =>
                        setSniperConfig({ ...sniperConfig, telegramChatId: e.target.value })
                      }
                      className="w-full bg-[#141B2D] border border-[#1E293B] rounded p-2 text-slate-300 text-xs font-mono outline-none focus:border-cyan-500/50"
                    />
                  </div>

                  <div className="flex items-center space-x-2 pt-1">
                    <button
                      onClick={() => {
                        engineClient.updateTelegramConfig({
                          botToken: sniperConfig.telegramBotToken,
                          chatId: sniperConfig.telegramChatId,
                        });
                        onAlertTrigger?.('INFO', 'CONFIG SAVED', 'Telegram credentials saved securely.');
                      }}
                      className="flex-1 py-2 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 font-bold text-xs transition"
                    >
                      Save Config
                    </button>
                    <button
                      onClick={handleTestTelegram}
                      disabled={isTestingTelegram}
                      className="flex-1 py-2 rounded bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-500/50 text-cyan-300 font-bold text-xs transition flex items-center justify-center space-x-1"
                    >
                      <Wifi className={`w-3.5 h-3.5 ${isTestingTelegram ? 'animate-spin text-cyan-400' : 'text-cyan-400'}`} />
                      <span>{isTestingTelegram ? 'Testing...' : 'Test Connection'}</span>
                    </button>
                  </div>

                  <div className="flex items-center space-x-2 pt-1">
                    <input
                      type="checkbox"
                      id="sendPingCb"
                      checked={sendPingMsg}
                      onChange={(e) => setSendPingMsg(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-900 text-cyan-500 text-xs"
                    />
                    <label htmlFor="sendPingCb" className="text-slate-400 text-[10px] cursor-pointer">
                      Send ping alert to Chat ID on verify
                    </label>
                  </div>

                  {/* Telegram Test Result Card */}
                  {telegramTestResult && (
                    <div
                      className={`p-2.5 rounded-lg border text-[11px] font-mono space-y-1.5 transition ${
                        telegramTestResult.botAuthorized
                          ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                          : telegramTestResult.reachable
                          ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                          : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
                      }`}
                    >
                      <div className="flex items-center justify-between font-bold">
                        <span className="flex items-center space-x-1">
                          {telegramTestResult.botAuthorized ? (
                            <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                          )}
                          <span>
                            {telegramTestResult.botAuthorized
                              ? 'BOT AUTHORIZED'
                              : telegramTestResult.reachable
                              ? 'REACHABLE (DEMO TOKEN)'
                              : 'CONNECTION FAILED'}
                          </span>
                        </span>
                        <span className="text-[10px] opacity-80">{telegramTestResult.latencyMs}ms RTT</span>
                      </div>

                      <p className="text-[10px] leading-relaxed opacity-90">{telegramTestResult.diagnosis}</p>

                      {telegramTestResult.botDetails && (
                        <div className="text-[10px] border-t border-emerald-500/30 pt-1 text-emerald-200">
                          Bot Handle: @{telegramTestResult.botDetails.username} (ID: {telegramTestResult.botDetails.id})
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="p-4 rounded-xl bg-[#101728] border border-[#1E293B] space-y-2 text-xs font-mono">
                  <span className="font-bold text-white flex items-center space-x-1.5">
                    <Terminal className="w-4 h-4 text-emerald-400" />
                    <span>Quick Command Reference</span>
                  </span>
                  <ul className="space-y-1 text-slate-400 text-[11px]">
                    <li><strong className="text-cyan-300">/signals</strong> - Show top 3 alpha signals</li>
                    <li><strong className="text-cyan-300">/snipe &lt;CA&gt; [$$]</strong> - Instant Jito snipe</li>
                    <li><strong className="text-cyan-300">/positions</strong> - View open PnL</li>
                    <li><strong className="text-cyan-300">/panic_sell</strong> - Dump all memecoins</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* COMPREHENSIVE OUTSIDE WORLD CONNECTIVITY & SIMULATION AUDIT MODAL */}
      {showDiagnosticsModal && diagnosticsResult && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6">
          <div className="bg-[#0A0E1A] border border-[#1E293B] rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden font-mono">
            {/* Modal Header */}
            <div className="p-4 border-b border-[#1E293B] bg-[#0E1424] flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                  <Globe className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center space-x-2">
                    <span>Live External Pipes & Simulation Scope Audit</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                      LIVE AUDIT
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    High-stakes verification of live network connections vs in-memory paper trading boundaries
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowDiagnosticsModal(false)}
                className="p-1.5 rounded-lg bg-[#141B2D] text-slate-400 hover:text-white border border-[#1E293B] transition"
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-6 text-xs">
              {/* SECTION 1: OUTSIDE WORLD NETWORK CONNECTIONS */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-bold text-slate-200 uppercase tracking-wider text-[11px] flex items-center space-x-1.5">
                    <Wifi className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Outside World Connectivity Verification</span>
                  </h4>
                  <span className="text-[10px] text-slate-400">
                    Audit Latency: {diagnosticsResult.totalAuditTimeMs}ms
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {/* Telegram */}
                  <div className="p-3 rounded-xl bg-[#101728] border border-[#1E293B] space-y-1.5">
                    <div className="flex items-center justify-between font-bold">
                      <span className="text-white flex items-center space-x-1.5">
                        <Send className="w-3.5 h-3.5 text-blue-400" />
                        <span>Telegram Bot Gateway</span>
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] ${
                          diagnosticsResult.connections.telegram.testResult.reachable
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                        }`}
                      >
                        {diagnosticsResult.connections.telegram.testResult.reachable ? 'REACHABLE' : 'UNREACHABLE'}
                      </span>
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">https://api.telegram.org</code>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{diagnosticsResult.connections.telegram.testResult.latencyMs}ms</strong> | Auth: {diagnosticsResult.connections.telegram.testResult.botAuthorized ? 'VALIDATED' : 'DEMO TOKEN (401)'}
                    </div>
                    <p className="text-slate-400 text-[10px] border-t border-slate-800 pt-1">
                      {diagnosticsResult.connections.telegram.testResult.diagnosis}
                    </p>
                  </div>

                  {/* X.com / Twitter */}
                  <div className="p-3 rounded-xl bg-[#101728] border border-[#1E293B] space-y-1.5">
                    <div className="flex items-center justify-between font-bold">
                      <span className="text-white flex items-center space-x-1.5">
                        <span className="text-sky-400 font-bold text-sm">𝕏</span>
                        <span>X.com / Twitter Gateway</span>
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] ${
                          diagnosticsResult.connections.xTwitter?.testResult?.reachable
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                        }`}
                      >
                        {probeBadge(diagnosticsResult.connections.xTwitter?.testResult, 'REACHABLE').text}
                      </span>
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">https://api.twitter.com</code>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{probeLatency(diagnosticsResult.connections.xTwitter?.testResult?.latencyMs)}</strong> | Mode: {diagnosticsResult.connections.xTwitter?.testResult?.bearerAuthorized ? 'AUTHENTICATED' : 'LIVE METADATA FEED'}
                    </div>
                    <p className="text-slate-400 text-[10px] border-t border-slate-800 pt-1">
                      {diagnosticsResult.connections.xTwitter?.testResult?.diagnosis ||
                        'Outbound HTTPS verified. Ingests live community links from Pump.fun and DexScreener.'}
                    </p>
                  </div>

                  {/* Pump.fun */}
                  <div className="p-3 rounded-xl bg-[#101728] border border-[#1E293B] space-y-1.5">
                    <div className="flex items-center justify-between font-bold">
                      <span className="text-white flex items-center space-x-1.5">
                        <Flame className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Pump.fun Live Coin Stream</span>
                      </span>
                      {(() => { const b = probeBadge(diagnosticsResult.connections.pumpFun.testResult, 'REACHABLE'); return (<span className={`px-2 py-0.5 rounded text-[10px] ${b.ok ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'}`}>{b.text}</span>); })()}
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">frontend-api-v3.pump.fun/coins</code>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{diagnosticsResult.connections.pumpFun.testResult.latencyMs}ms</strong> | Newest: {diagnosticsResult.connections.pumpFun.testResult.newestToken || 'Active'}
                    </div>
                    <p className="text-slate-400 text-[10px] border-t border-slate-800 pt-1">
                      Live Solana bonding curves streamed and processed every 5s.
                    </p>
                  </div>

                  {/* DexScreener */}
                  <div className="p-3 rounded-xl bg-[#101728] border border-[#1E293B] space-y-1.5">
                    <div className="flex items-center justify-between font-bold">
                      <span className="text-white flex items-center space-x-1.5">
                        <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
                        <span>DexScreener Boosted Feed</span>
                      </span>
                      {(() => { const b = probeBadge(diagnosticsResult.connections.dexScreener.testResult, 'REACHABLE'); return (<span className={`px-2 py-0.5 rounded text-[10px] ${b.ok ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'}`}>{b.text}</span>); })()}
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">api.dexscreener.com/token-boosts</code>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{diagnosticsResult.connections.dexScreener.testResult.latencyMs}ms</strong> | Boosted Queue: {diagnosticsResult.connections.dexScreener.testResult.boostedCount} Tokens
                    </div>
                    <p className="text-slate-400 text-[10px] border-t border-slate-800 pt-1">
                      Pulls live community paid boosts used for multi-caller confluence trigger.
                    </p>
                  </div>

                  {/* Solana Cluster */}
                  <div className="p-3 rounded-xl bg-[#101728] border border-[#1E293B] space-y-1.5">
                    <div className="flex items-center justify-between font-bold">
                      <span className="text-white flex items-center space-x-1.5">
                        <Server className="w-3.5 h-3.5 text-purple-400" />
                        <span>Solana Validator JSON-RPC</span>
                      </span>
                      {(() => { const b = probeBadge(diagnosticsResult.connections.solanaRpc.testResult, 'RPC REACHABLE'); return (<span className={`px-2 py-0.5 rounded text-[10px] ${b.ok ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'}`}>{b.text}</span>); })()}
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">{hostOfService(diagnosticsResult.connections.solanaRpc.service)}</code>{diagnosticsResult.cluster ? <span className="ml-2 text-amber-300">cluster: {diagnosticsResult.cluster}</span> : null}
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{diagnosticsResult.connections.solanaRpc.testResult.latencyMs}ms</strong> | Cluster Slot: #{diagnosticsResult.connections.solanaRpc.testResult.slot}
                    </div>
                    <p className="text-slate-400 text-[10px] border-t border-slate-800 pt-1">
                      Direct JSON-RPC slot verification for block leader schedules.
                    </p>
                  </div>
                </div>
              </div>

              {/* SECTION 2: MARKET MAKER & CALLER PERSONAS */}
              <div>
                <h4 className="font-bold text-slate-200 uppercase tracking-wider text-[11px] mb-2 flex items-center space-x-1.5">
                  <Crosshair className="w-3.5 h-3.5 text-amber-400" />
                  <span>Market Maker & Caller Profiles Attribution</span>
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                  {diagnosticsResult.marketMakerProfiles.profiles.map((p: any) => (
                    <div key={p.userId} className="p-2.5 rounded-lg bg-[#101728] border border-[#1E293B] space-y-1">
                      <div className="font-bold text-white text-xs truncate">@{p.userId}</div>
                      <div className="text-[10px] text-amber-400">{p.reputationTier}</div>
                      <div className="text-[10px] text-slate-400 flex justify-between">
                        <span>2x Win:</span>
                        <strong className="text-emerald-400">{p.winRate2x}</strong>
                      </div>
                      <div className="text-[10px] text-slate-400 flex justify-between">
                        <span>Avg Mult:</span>
                        <strong className="text-cyan-400">{p.avgMultiple}</strong>
                      </div>
                      <div className="text-[10px] text-slate-500 truncate pt-1 border-t border-slate-800">
                        {p.primaryWallet.slice(0, 4)}...{p.primaryWallet.slice(-4)}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 p-2.5 rounded-lg bg-[#0C1220] border border-[#1E293B] text-[11px] flex items-center justify-between">
                  <span className="text-slate-400">
                    Active Hot Callouts: <strong className="text-white">{diagnosticsResult.marketMakerProfiles.activeCalloutsCount}</strong>
                  </span>
                  <span className="text-cyan-300">
                    Multi-Caller Confluences: <strong className="text-emerald-400">{diagnosticsResult.marketMakerProfiles.multiCallerConfluenceCount}</strong> tokens
                  </span>
                </div>
              </div>

              {/* SECTION 3: SIMULATION SCOPE AUDIT MATRIX */}
              <div>
                <h4 className="font-bold text-slate-200 uppercase tracking-wider text-[11px] mb-2 flex items-center space-x-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>What is Live vs What is Simulated</span>
                </h4>
                <div className="border border-[#1E293B] rounded-xl overflow-hidden">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-[#121A2F] text-slate-300 uppercase text-[10px]">
                      <tr>
                        <th className="p-2.5">Subsystem</th>
                        <th className="p-2.5">Nature</th>
                        <th className="p-2.5">Architecture & Guarantees</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1E293B] bg-[#0A0E1A]">
                      {diagnosticsResult.simulationScopeMatrix.map((item: any, i: number) => (
                        <tr key={i} className="hover:bg-[#101728]">
                          <td className="p-2.5 font-bold text-white">{item.subsystem}</td>
                          <td className="p-2.5">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                item.nature === 'LIVE' || item.nature === 'LIVE_COMPUTATION' || item.nature === 'LIVE_READY'
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              }`}
                            >
                              {item.nature}
                            </span>
                          </td>
                          <td className="p-2.5 text-slate-400 text-[10px] leading-relaxed">{item.details}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-[#1E293B] bg-[#0E1424] flex items-center justify-between">
              <div className="text-[11px] text-slate-400 flex items-center space-x-1.5">
                <Info className="w-3.5 h-3.5 text-cyan-400" />
                <span>Paper trades risk no real capital. The status above is from the probe that just ran; a trade is only as live as the mode shown in the header.</span>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleRunDiagnostics}
                  disabled={isTestingDiagnostics}
                  className="px-3 py-1.5 rounded-lg bg-cyan-950 border border-cyan-500/40 text-cyan-300 text-xs font-bold hover:bg-cyan-900 transition"
                >
                  {isTestingDiagnostics ? 'Refreshing...' : 'Re-Run Live Audit'}
                </button>
                <button
                  onClick={() => setShowDiagnosticsModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold border border-slate-700 transition"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* External Token Explorer & Web Platform Modal */}
      <TokenExternalLinksModal
        isOpen={Boolean(selectedExternalToken)}
        onClose={() => setSelectedExternalToken(null)}
        tokenData={selectedExternalToken}
      />
    </div>
  );
};
