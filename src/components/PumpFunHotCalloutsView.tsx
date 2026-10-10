import { useTradingMode, liveClickWarning } from '../utils/tradingMode';
import { authorityBadge, authorityTone, holderPct } from '../utils/authorityBadge';
import React, { useState, useEffect } from 'react';
import {
  Flame,
  Award,
  TrendingUp,
  Zap,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Copy,
  Check,
  Search,
  Filter,
  ShieldCheck,
  Sparkles,
  Clock,
  ArrowUpRight,
  Users,
  Radio,
  Eye,
  RefreshCw,
  Coins,
  Settings,
  Globe,
  Bot,
} from 'lucide-react';
import {
  PumpFunHotCallout,
  PumpFunCaller,
  PumpFunHotCalloutsResponse,
} from '../types';
import { engineClient } from '../services/engineClient';
import { hftAudio } from '../utils/audio';
import {
  sanitizeExternalUrl,
  sanitizeTwitterUrl,
  sanitizeTelegramUrl,
} from '../utils/tokenLinks';

interface PumpFunHotCalloutsViewProps {
  capitalTier?: 'MICRO_10' | 'INSTITUTIONAL';
  onAlertTrigger?: (level: 'INFO' | 'WARNING' | 'CRITICAL', title: string, message: string) => void;
  onRefreshParent?: () => void;
}

export const PumpFunHotCalloutsView: React.FC<PumpFunHotCalloutsViewProps> = ({
  capitalTier = 'MICRO_10',
  onAlertTrigger,
  onRefreshParent,
}) => {
  const tradingMode = useTradingMode();
  const [subTab, setSubTab] = useState<'CALLOUTS' | 'LEADERBOARD' | 'RULES'>('CALLOUTS');
  const [callouts, setCallouts] = useState<PumpFunHotCallout[]>([]);
  const [leaderboard, setLeaderboard] = useState<PumpFunCaller[]>([]);
  const [statusInfo, setStatusInfo] = useState<{
    liveSource: string;
    syncLatencyMs: number;
    tokensTrackedCount: number;
    lastUpdated: number;
  }>({
    liveSource: '—',
    syncLatencyMs: 0,
    tokensTrackedCount: 0,
    lastUpdated: Date.now(),
  });

  const [rules, setRules] = useState({
    minCallerWinRate2x: 40.0,
    minAvgMultiple: 4.0,
    autoSnipeOnConfluence: true,
    maxEntryMultiple: 1.35,
    maxElapsedSeconds: 60,
    snipeAmountUsd: capitalTier === 'MICRO_10' ? 5.0 : 25.0,
    jitoPriorityTipSol: 0.00018,
  });

  const [activeFilter, setActiveFilter] = useState<'ALL' | 'CONFLUENCE' | 'TOP_WHALES' | 'FRESH' | 'MIGRATING'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedCa, setCopiedCa] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [snipingCalloutId, setSnipingCalloutId] = useState<string | null>(null);
  const [selectedCallerModal, setSelectedCallerModal] = useState<PumpFunCaller | null>(null);

  const [isWsLive, setIsWsLive] = useState(engineClient.isWsConnected());

  // Fetch callouts from backend (which polls real pump.fun & DexScreener)
  const fetchData = async () => {
    try {
      const data: PumpFunHotCalloutsResponse = await engineClient.getPumpFunCallouts();
      if (data && data.callouts) {
        setCallouts(data.callouts);
        setLeaderboard(data.leaderboard || []);
        setStatusInfo({
          liveSource: data.liveSource || '—',
          syncLatencyMs: data.syncLatencyMs ?? 0,
          tokensTrackedCount: data.tokensTrackedCount ?? 0,
          lastUpdated: data.lastUpdated || Date.now(),
        });
        if (data.autoSnipeRules) {
          setRules(data.autoSnipeRules);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchData();

    // Real-time WebSocket subscriptions
    const unsubHotCallouts = engineClient.onPumpHotCallouts((data) => {
      setIsWsLive(true);
      if (data.callouts) setCallouts(data.callouts);
      if (data.leaderboard) setLeaderboard(data.leaderboard);
      if (data.status) {
        setStatusInfo({
          liveSource: data.status.liveSource || '—',
          syncLatencyMs: data.status.syncLatencyMs ?? 0,
          tokensTrackedCount: data.status.tokensTrackedCount ?? 0,
          lastUpdated: data.status.lastSyncTimestamp || Date.now(),
        });
      }
    });

    const unsubCalloutSniped = engineClient.onCalloutSniped((data) => {
      if (data?.callout) {
        setCallouts((prev) =>
          prev.map((c) => (c.id === data.callout.id ? { ...c, status: 'SNIPED' } : c))
        );
        onAlertTrigger?.(
          'INFO',
          `⚡ AUTONOMOUS CALLOUT SNIPED: $${data.callout.token.symbol}`,
          data.tradeRes?.message || `Executed Jito MEV Snipe on Pump.fun for $${data.callout.token.symbol}`
        );
        onRefreshParent?.();
      }
    });

    // Gentle polling fallback in case WS is interrupted
    const interval = setInterval(() => {
      setIsWsLive(engineClient.isWsConnected());
      fetchData();
    }, 6000);

    return () => {
      unsubHotCallouts();
      unsubCalloutSniped();
      clearInterval(interval);
    };
  }, []);

  const handleManualSync = async () => {
    setIsRefreshing(true);
    hftAudio.playClick();
    await engineClient.refreshPumpFunData();
    await fetchData();
    setIsRefreshing(false);
  };

  const copyToClipboard = (ca: string) => {
    navigator.clipboard.writeText(ca);
    setCopiedCa(ca);
    hftAudio.playClick();
    setTimeout(() => setCopiedCa(null), 2000);
  };

  const handleSnipeCallout = async (callout: PumpFunHotCallout) => {
    const defaultAmount = capitalTier === 'MICRO_10' ? 5.0 : 25.0;
    // Q10b: while LIVE is armed this click sends a real transaction; say so and ask first
    const warning = liveClickWarning(tradingMode, `Sniping $${callout.token.symbol} for $${defaultAmount.toFixed(2)}`);
    if (warning && !window.confirm(warning)) return;
    setSnipingCalloutId(callout.id);
    hftAudio.playOrderFill();

    const res = await engineClient.snipePumpFunCallout(
      callout.id,
      defaultAmount,
      rules.jitoPriorityTipSol,
      6.0,
      tradingMode.live
    );

    if (res?.status === 'OK' && res?.result?.success) {
      onAlertTrigger?.(
        'INFO',
        `⚡ HOT CALLOUT SNIPED: $${callout.token.symbol}`,
        `Executed $${defaultAmount.toFixed(2)} on Pump.fun via Jito MEV Bundle. Caller: @${callout.caller.userId} (Avg: ${callout.caller.avgMultiple}x)`
      );
      setCallouts((prev) =>
        prev.map((c) => (c.id === callout.id ? { ...c, status: 'SNIPED' } : c))
      );
      onRefreshParent?.();
    } else {
      onAlertTrigger?.(
        'WARNING',
        'SNIPE REJECTED',
        res?.result?.message || 'Failed pre-trade risk or curve check'
      );
    }
    setSnipingCalloutId(null);
  };

  const handleToggleAutoSnipe = async (userId: string) => {
    hftAudio.playClick();
    const res = await engineClient.togglePumpFunAutoSnipe(userId);
    if (res?.status === 'OK' && res?.caller) {
      setLeaderboard((prev) =>
        prev.map((c) => (c.userId === userId ? res.caller : c))
      );
      setCallouts((prev) =>
        prev.map((c) =>
          c.caller.userId === userId
            ? { ...c, caller: { ...c.caller, isAutoSnipeSubscribed: res.caller.isAutoSnipeSubscribed } }
            : c
        )
      );
      onAlertTrigger?.(
        'INFO',
        `CALLER SUBSCRIPTION UPDATED`,
        `Auto-snipe for @${userId} is now ${res.caller.isAutoSnipeSubscribed ? 'ENABLED' : 'DISABLED'}`
      );
    }
  };

  const handleSaveRules = async () => {
    hftAudio.playClick();
    const res = await engineClient.updatePumpFunRules(rules);
    if (res?.status === 'OK') {
      onAlertTrigger?.('INFO', 'AUTO-SNIPE RULES UPDATED', 'Pump.fun HFT callout parameters saved');
    }
  };

  // Filter callouts
  const filteredCallouts = callouts.filter((c) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchSymbol = c.token.symbol.toLowerCase().includes(q);
      const matchName = c.token.name.toLowerCase().includes(q);
      const matchMint = c.token.mint.toLowerCase().includes(q);
      const matchCaller = c.caller.userId.toLowerCase().includes(q);
      if (!matchSymbol && !matchName && !matchMint && !matchCaller) return false;
    }

    if (activeFilter === 'CONFLUENCE') return c.confluenceCount >= 2;
    if (activeFilter === 'TOP_WHALES') return c.caller.reputationTier === 'LEGENDARY_WHALE';
    if (activeFilter === 'FRESH') return (Date.now() - c.calloutTimestamp) / 1000 <= 90;
    if (activeFilter === 'MIGRATING') return c.token.bondingCurveProgress >= 70;

    return true;
  });

  return (
    <div className="space-y-4">
      {/* REAL-WORLD API CONNECTIVITY BANNER */}
      <div className="p-3 rounded-xl bg-gradient-to-r from-rose-950/50 via-purple-950/40 to-[#0F172A] border border-rose-500/40 flex flex-wrap items-center justify-between gap-3 shadow-md">
        <div className="flex items-center space-x-3">
          <div className="h-9 w-9 rounded-lg bg-rose-500/20 border border-rose-500/50 flex items-center justify-center flex-shrink-0">
            <Flame className="w-5 h-5 text-rose-400 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                Pump.fun Hot Callouts & Caller Reputation Engine
              </span>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
                <span>LIVE API v3</span>
              </span>
              {isWsLive && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 flex items-center space-x-1">
                  <Radio className="w-2.5 h-2.5 text-cyan-400 animate-pulse" />
                  <span>WS STREAMING</span>
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-300 mt-0.5">
              Live ingest: <span className="font-mono text-cyan-300">{statusInfo.liveSource}</span> • {statusInfo.tokensTrackedCount} on-chain tokens monitored • Latency: <span className="font-mono text-emerald-400">{statusInfo.syncLatencyMs > 0 ? `${statusInfo.syncLatencyMs}ms` : '—'}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <div className="px-2.5 py-1 rounded bg-[#0A0E1A] border border-[#1E293B] text-[11px] font-mono text-slate-300 hidden md:block">
            Synced: <span className="text-white font-semibold">{new Date(statusInfo.lastUpdated).toLocaleTimeString()}</span>
          </div>

          <button
            onClick={handleManualSync}
            disabled={isRefreshing}
            className="px-2.5 py-1 rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white text-xs font-mono font-bold transition flex items-center space-x-1.5 border border-rose-400/50 shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>Force Live Sync</span>
          </button>
        </div>
      </div>

      {/* SUB TABS: CALLOUTS STREAM, LEADERBOARD, RULES */}
      <div className="flex items-center justify-between border-b border-[#1E293B] pb-1">
        <div className="flex items-center space-x-2">
          <button
            onClick={() => {
              setSubTab('CALLOUTS');
              hftAudio.playClick();
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition flex items-center space-x-1.5 ${
              subTab === 'CALLOUTS'
                ? 'bg-rose-500/20 border border-rose-500/50 text-rose-300'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Flame className="w-3.5 h-3.5 text-rose-400" />
            <span>Live Hot Callouts ({callouts.length})</span>
          </button>

          <button
            onClick={() => {
              setSubTab('LEADERBOARD');
              hftAudio.playClick();
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition flex items-center space-x-1.5 ${
              subTab === 'LEADERBOARD'
                ? 'bg-amber-500/20 border border-amber-500/50 text-amber-300'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Award className="w-3.5 h-3.5 text-amber-400" />
            <span>Top Caller Leaderboard ({leaderboard.length})</span>
          </button>

          <button
            onClick={() => {
              setSubTab('RULES');
              hftAudio.playClick();
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition flex items-center space-x-1.5 ${
              subTab === 'RULES'
                ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-300'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Settings className="w-3.5 h-3.5 text-cyan-400" />
            <span>Auto-Sniper Strategy Rules</span>
          </button>
        </div>

        {subTab === 'CALLOUTS' && (
          <div className="text-[11px] font-mono text-slate-400 hidden sm:block">
            Showing <span className="text-white font-bold">{filteredCallouts.length}</span> verified hot calls
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* 1. HOT CALLOUTS STREAM VIEW */}
      {/* ========================================================================= */}
      {subTab === 'CALLOUTS' && (
        <div className="space-y-3">
          {/* Quick Auto-Sniper Status Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-gradient-to-r from-[#0F172A] to-[#1E1B4B] border border-cyan-500/30 shadow-lg">
            <div className="flex items-center space-x-2.5">
              <Bot className="w-5 h-5 text-cyan-400 animate-pulse" />
              <div>
                <div className="text-xs font-mono font-bold text-white flex items-center space-x-2">
                  <span>AUTONOMOUS CALLOUT SNIPER</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    JITO MEV BUNDLES
                  </span>
                </div>
                <div className="text-[11px] text-slate-400">
                  Toggle Auto-Snipe on specific callers below or in the Leaderboard to automatically snipe their signals.
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={() => {
                  setSubTab('LEADERBOARD');
                  hftAudio.playClick();
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-mono font-bold bg-cyan-600/30 hover:bg-cyan-600/50 text-cyan-300 border border-cyan-500/50 transition flex items-center space-x-1.5"
              >
                <Award className="w-3.5 h-3.5 text-amber-400" />
                <span>Manage Subscriptions ({leaderboard.filter(c => c.isAutoSnipeSubscribed).length} Active)</span>
              </button>
            </div>
          </div>

          {/* SEARCH & FILTER CONTROLS */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg bg-[#0F1524] border border-[#1E293B]">
            <div className="flex items-center space-x-1.5 flex-wrap">
              <span className="text-xs font-mono text-slate-400 mr-1 flex items-center">
                <Filter className="w-3 h-3 mr-1" /> Filter:
              </span>

              <button
                onClick={() => setActiveFilter('ALL')}
                className={`px-2.5 py-1 rounded text-xs font-mono transition ${
                  activeFilter === 'ALL'
                    ? 'bg-slate-700 text-white font-bold'
                    : 'bg-[#141B2D] text-slate-400 hover:text-slate-200'
                }`}
              >
                All Calls
              </button>

              <button
                onClick={() => setActiveFilter('CONFLUENCE')}
                className={`px-2.5 py-1 rounded text-xs font-mono transition flex items-center space-x-1 ${
                  activeFilter === 'CONFLUENCE'
                    ? 'bg-rose-600 text-white font-bold shadow-sm'
                    : 'bg-[#141B2D] text-rose-300 hover:bg-rose-950/60'
                }`}
              >
                <Sparkles className="w-3 h-3" />
                <span>Multi-Caller Confluence</span>
              </button>

              <button
                onClick={() => setActiveFilter('TOP_WHALES')}
                className={`px-2.5 py-1 rounded text-xs font-mono transition flex items-center space-x-1 ${
                  activeFilter === 'TOP_WHALES'
                    ? 'bg-amber-600 text-white font-bold'
                    : 'bg-[#141B2D] text-amber-300 hover:bg-amber-950/60'
                }`}
              >
                <Award className="w-3 h-3" />
                <span>Legendary Whales Only</span>
              </button>

              <button
                onClick={() => setActiveFilter('FRESH')}
                className={`px-2.5 py-1 rounded text-xs font-mono transition flex items-center space-x-1 ${
                  activeFilter === 'FRESH'
                    ? 'bg-emerald-600 text-white font-bold'
                    : 'bg-[#141B2D] text-emerald-300 hover:bg-emerald-950/60'
                }`}
              >
                <Clock className="w-3 h-3" />
                <span>Prime Window (&lt;90s)</span>
              </button>

              <button
                onClick={() => setActiveFilter('MIGRATING')}
                className={`px-2.5 py-1 rounded text-xs font-mono transition flex items-center space-x-1 ${
                  activeFilter === 'MIGRATING'
                    ? 'bg-cyan-600 text-white font-bold'
                    : 'bg-[#141B2D] text-cyan-300 hover:bg-cyan-950/60'
                }`}
              >
                <TrendingUp className="w-3 h-3" />
                <span>Near Migration (&gt;70%)</span>
              </button>
            </div>

            {/* SEARCH INPUT */}
            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
              <input
                type="text"
                placeholder="Search symbol, caller, mint..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1 text-xs bg-[#090D16] border border-[#1E293B] rounded text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-500 font-mono"
              />
            </div>
          </div>

          {/* CALLOUT CARDS LIST */}
          <div className="grid grid-cols-1 gap-3 max-h-[520px] overflow-y-auto pr-1">
            {filteredCallouts.length === 0 ? (
              <div className="p-8 text-center bg-[#0C101C] rounded-xl border border-[#1E293B]">
                <Flame className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                <p className="text-sm text-slate-300 font-bold">No callouts match the selected filter</p>
                <p className="text-xs text-slate-500 mt-1">Try switching to &quot;All Calls&quot; or force a real-time sync</p>
              </div>
            ) : (
              filteredCallouts.map((c, cIdx) => {
                const isPrime = c.hftAction === 'INSTANT_SNIPE';
                const isDumpRisk = c.hftAction === 'DUMP_RISK';
                const isConfluence = c.confluenceCount >= 2;

                return (
                  <div
                    key={`callout-${c.id}-${c.token.mint}-${cIdx}`}
                    className={`p-4 rounded-xl border transition-all ${
                      isConfluence
                        ? 'bg-[#11162B] border-rose-500/50 shadow-lg shadow-rose-950/20'
                        : isPrime
                        ? 'bg-[#0E1526] border-emerald-500/40'
                        : 'bg-[#0D1220] border-[#1E293B] hover:border-slate-700'
                    }`}
                  >
                    {/* TOP HEADER: CALLER INFO & HFT DECAY TIMER */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E293B]/80 pb-3 mb-3">
                      {/* CALLER BADGE */}
                      <div className="flex items-center space-x-2.5">
                        <img
                          src={c.caller.avatarUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=120&auto=format&fit=crop&q=80'}
                          alt={c.caller.userId}
                          className="w-8 h-8 rounded-full border border-slate-700 object-cover"
                        />
                        <div>
                          <div className="flex items-center space-x-1.5">
                            <span
                              onClick={() => setSelectedCallerModal(c.caller)}
                              className="text-xs font-bold text-white hover:text-cyan-400 cursor-pointer font-mono flex items-center space-x-1"
                            >
                              <span>@{c.caller.userId}</span>
                              <Eye className="w-3 h-3 text-slate-500" />
                            </span>

                            {/* REPUTATION TIER BADGE */}
                            <span
                              className={`px-1.5 py-0.2 rounded text-[9px] font-mono font-bold ${
                                c.caller.reputationTier === 'LEGENDARY_WHALE'
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                  : c.caller.reputationTier === 'VERIFIED_ALPHA'
                                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                                  : 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                              }`}
                            >
                              {c.caller.reputationTier.replace('_', ' ')}
                            </span>

                            {/* MULTI-CALLER CONFLUENCE BADGE */}
                            {isConfluence && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-black bg-rose-500 text-white animate-pulse shadow-sm flex items-center space-x-1">
                                <Sparkles className="w-3 h-3" />
                                <span>{c.confluenceCount}x CONFLUENCE HIT</span>
                              </span>
                            )}
                          </div>

                          <div className="text-[10px] font-mono text-slate-400 flex items-center space-x-2 mt-0.5">
                            <span>
                              Win Rate (2x+): <span className="text-emerald-400 font-bold">{c.caller.winRate2x}%</span>
                            </span>
                            <span>•</span>
                            <span>
                              Avg Multiple: <span className="text-amber-400 font-bold">{c.caller.avgMultiple}x</span>
                            </span>
                            <span>•</span>
                            <span>
                              Time to Peak: <span className="text-cyan-400">{Math.round(c.caller.avgTimeToPeakMs / 60000)}m</span>
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* HFT DECAY WINDOW & ACTION BADGE */}
                      <div className="flex items-center space-x-2">
                        {/* Status tag */}
                        <div
                          className={`px-2 py-1 rounded-lg text-xs font-mono font-bold flex items-center space-x-1.5 ${
                            isPrime
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 animate-pulse'
                              : isDumpRisk
                              ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                              : 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                          }`}
                        >
                          <Zap className="w-3.5 h-3.5" />
                          <span>{c.hftAction.replace('_', ' ')}</span>
                        </div>

                        {/* Time elapsed */}
                        <div className="px-2 py-1 rounded bg-[#090D16] border border-[#1E293B] text-[11px] font-mono text-slate-300 flex items-center space-x-1">
                          <Clock className="w-3 h-3 text-slate-500" />
                          <span>{c.token.timeAgoStr}</span>
                        </div>
                      </div>
                    </div>

                    {/* MAIN TOKEN ROW: LOGO, SYMBOL, CA, BONDING CURVE, PRICING */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
                      {/* TOKEN IDENTITY (Cols 1-4) */}
                      <div className="lg:col-span-4 flex items-start space-x-3">
                        <img
                          src={c.token.imageUri}
                          alt={c.token.symbol}
                          className="w-11 h-11 rounded-lg border border-slate-700 object-cover flex-shrink-0"
                          onError={(e) => {
                            (e.target as HTMLImageElement).src =
                              'https://images.unsplash.com/photo-1622979135225-d2ba269bc1df?w=120&auto=format&fit=crop&q=80';
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center space-x-2">
                            <span className="font-extrabold text-white text-sm tracking-wide font-sans">
                              ${c.token.symbol}
                            </span>
                            <span className="text-xs text-slate-400 truncate max-w-[120px]">
                              {c.token.name}
                            </span>
                          </div>

                          {/* MINT CONTRACT ADDRESS */}
                          <div className="flex items-center space-x-1.5 mt-1">
                            <span className="text-[10px] font-mono text-slate-500 bg-[#090D16] px-1.5 py-0.5 rounded border border-[#1E293B] truncate max-w-[130px]">
                              {c.token.mint}
                            </span>
                            <button
                              onClick={() => copyToClipboard(c.token.mint)}
                              className="text-slate-400 hover:text-white p-0.5 rounded transition"
                              title="Copy Mint Address"
                            >
                              {copiedCa === c.token.mint ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>

                            {/* External Links */}
                            <a
                              href={`https://pump.fun/coin/${c.token.mint}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate-400 hover:text-rose-400 p-0.5 text-[9px] font-mono flex items-center gap-0.5"
                              title="View on Pump.fun"
                            >
                              <ExternalLink className="w-3 h-3 text-rose-400" />
                              <span>PUMP</span>
                            </a>
                            <a
                              href={`https://dexscreener.com/solana/${c.token.mint}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate-400 hover:text-cyan-400 p-0.5 text-[9px] font-mono flex items-center gap-0.5"
                              title="DexScreener Live Candlestick Chart"
                            >
                              <span className="text-cyan-400 font-bold">DEX</span>
                            </a>
                            <a
                              href={`https://gmgn.ai/sol/token/${c.token.mint}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate-400 hover:text-emerald-400 p-0.5 text-[9px] font-mono flex items-center gap-0.5"
                              title="GMGN Smart Money & Dev Holdings"
                            >
                              <span className="text-emerald-400 font-bold">GMGN</span>
                            </a>

                            {/* Verified X.com Link */}
                            {(() => {
                              const twitterUrl = sanitizeTwitterUrl(c.token.twitter, c.token.symbol, true);
                              const hasOfficial = Boolean(c.token.twitter && c.token.twitter.toLowerCase() !== 'none');
                              return (
                                <a
                                  href={twitterUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`p-0.5 text-[9px] font-mono flex items-center gap-0.5 px-1 rounded transition ${
                                    hasOfficial
                                      ? 'text-sky-300 bg-sky-500/20 border border-sky-500/40 hover:bg-sky-500/30'
                                      : 'text-slate-400 hover:text-sky-400 hover:bg-slate-800'
                                  }`}
                                  title={hasOfficial ? `Official 𝕏: ${c.token.twitter}` : `Search $${c.token.symbol} on 𝕏`}
                                >
                                  <span className="font-bold">𝕏</span>
                                  {hasOfficial && <span className="text-[8px] uppercase">LINK</span>}
                                </a>
                              );
                            })()}

                            {/* Verified Telegram Link */}
                            {(() => {
                              const tgUrl = sanitizeTelegramUrl(c.token.telegram);
                              if (!tgUrl) return null;
                              return (
                                <a
                                  href={tgUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-blue-300 bg-blue-500/20 border border-blue-500/40 hover:bg-blue-500/30 p-0.5 text-[9px] font-mono flex items-center gap-0.5 px-1 rounded transition"
                                  title={`Verified Telegram: ${tgUrl}`}
                                >
                                  <span className="font-bold">TG</span>
                                </a>
                              );
                            })()}

                            {/* Verified Website Link */}
                            {(() => {
                              const webUrl = sanitizeExternalUrl(c.token.website);
                              if (!webUrl) return null;
                              return (
                                <a
                                  href={webUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-emerald-300 bg-emerald-500/20 border border-emerald-500/40 hover:bg-emerald-500/30 p-0.5 text-[9px] font-mono flex items-center gap-0.5 px-1 rounded transition"
                                  title={`Verified Website: ${webUrl}`}
                                >
                                  <Globe className="w-2.5 h-2.5" />
                                </a>
                              );
                            })()}
                          </div>
                        </div>
                      </div>

                      {/* BONDING CURVE & RUGCHECK (Cols 5-7) */}
                      <div className="lg:col-span-3 space-y-1.5">
                        <div className="flex justify-between text-[11px] font-mono">
                          <span className="text-slate-400 flex items-center space-x-1">
                            <span>Bonding Curve:</span>
                          </span>
                          <span
                            className={`font-bold ${
                              c.token.bondingCurveProgress >= 80
                                ? 'text-cyan-400 animate-pulse'
                                : 'text-slate-200'
                            }`}
                          >
                            {c.token.complete ? 'MIGRATED (100%)' : `${c.token.bondingCurveProgress}%`}
                          </span>
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              c.token.complete
                                ? 'bg-gradient-to-r from-emerald-500 to-cyan-400'
                                : c.token.bondingCurveProgress >= 70
                                ? 'bg-gradient-to-r from-amber-500 to-rose-500'
                                : 'bg-gradient-to-r from-blue-500 to-cyan-400'
                            }`}
                            style={{ width: `${Math.min(100, c.token.bondingCurveProgress)}%` }}
                          />
                        </div>

                        {/* Security check badges */}
                        <div className="flex items-center space-x-2 text-[10px] font-mono text-slate-400">
                          {(() => {
                            const b = authorityBadge('Mint', c.token.isMintRevoked as boolean | null);
                            return (
                              <span className={`${authorityTone[b.tone]} flex items-center`}>
                                <ShieldCheck className="w-3 h-3 mr-0.5" /> {b.text}
                              </span>
                            );
                          })()}
                          <span>•</span>
                          <span className="text-slate-400">
                            Dev: <span className="text-white font-semibold">{holderPct(c.token.devHoldingPct)}</span>
                          </span>
                        </div>
                      </div>

                      {/* CALLOUT PRICING & MULTIPLES (Cols 8-10) */}
                      <div className="lg:col-span-3 grid grid-cols-2 gap-2 text-xs font-mono">
                        <div className="p-2 rounded bg-[#090D16] border border-[#1E293B]">
                          <div className="text-[10px] text-slate-500 uppercase">Callout Mcap</div>
                          <div className="font-bold text-slate-300">
                            ${Math.round(c.token.marketCapAtCalloutUsd).toLocaleString()}
                          </div>
                        </div>

                        <div className="p-2 rounded bg-[#090D16] border border-[#1E293B]">
                          <div className="text-[10px] text-slate-500 uppercase">Multiple Reached</div>
                          <div className="font-extrabold text-emerald-400 flex items-center space-x-0.5">
                            <ArrowUpRight className="w-3 h-3" />
                            <span>{c.token.currentMultiple.toFixed(2)}x</span>
                            <span className="text-[10px] text-slate-400 ml-1">
                              (ATH: {c.token.peakMultiple.toFixed(2)}x)
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* 1-CLICK SNIPE ACTION (Cols 11-12) */}
                      <div className="lg:col-span-2 flex flex-col space-y-1.5">
                        <button
                          onClick={() => handleSnipeCallout(c)}
                          disabled={snipingCalloutId === c.id || c.status === 'SNIPED'}
                          className={`w-full py-2 px-3 rounded-lg font-mono font-bold text-xs transition flex items-center justify-center space-x-1.5 shadow-md ${
                            c.status === 'SNIPED'
                              ? 'bg-emerald-950/80 border border-emerald-500/50 text-emerald-300 cursor-default'
                              : isDumpRisk
                              ? 'bg-amber-900/70 hover:bg-amber-800 text-amber-200 border border-amber-500/40'
                              : 'bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500 text-white border border-rose-400/50 shadow-rose-950/40'
                          }`}
                        >
                          <Zap className="w-3.5 h-3.5" />
                          <span>
                            {c.status === 'SNIPED'
                              ? 'SNIPED ✓'
                              : snipingCalloutId === c.id
                              ? 'BUNDLING...'
                              : `1-CLICK JITO ($${capitalTier === 'MICRO_10' ? '5' : '25'})`}
                          </span>
                        </button>

                        <div className="text-center text-[10px] font-mono text-slate-500">
                          Jito MEV {rules.jitoPriorityTipSol} SOL Tip
                        </div>

                        {/* Caller Auto-Snipe Toggle */}
                        <button
                          onClick={() => handleToggleAutoSnipe(c.caller.userId)}
                          className={`w-full py-1 px-2 rounded text-[10px] font-mono font-bold transition flex items-center justify-center space-x-1 border ${
                            c.caller.isAutoSnipeSubscribed
                              ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 shadow-sm'
                              : 'bg-[#141B2D] text-slate-400 border-[#1E293B] hover:text-white hover:border-slate-600'
                          }`}
                          title={c.caller.isAutoSnipeSubscribed ? 'Click to disable auto-snipe for this caller' : 'Click to automatically snipe all callouts from this caller'}
                        >
                          <Bot className="w-3 h-3 text-cyan-400" />
                          <span>{c.caller.isAutoSnipeSubscribed ? 'AUTO-SNIPE: ON' : 'AUTO-SNIPE: OFF'}</span>
                        </button>
                      </div>
                    </div>

                    {/* CALLOUT NOTE & OTHER CALLERS */}
                    <div className="mt-3 pt-2 border-t border-[#1E293B]/60 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <p className="text-[11px] text-slate-300 font-sans italic flex-1">
                        &ldquo;{c.calloutNote}&rdquo;
                      </p>

                      {c.otherCallers && c.otherCallers.length > 0 && (
                        <div className="flex items-center space-x-1 text-[10px] font-mono text-slate-400">
                          <Users className="w-3 h-3 text-rose-400" />
                          <span>Also called by:</span>
                          <span className="text-rose-300 font-bold">{c.otherCallers.join(', ')}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. CALLER LEADERBOARD VIEW */}
      {/* ========================================================================= */}
      {subTab === 'LEADERBOARD' && (
        <div className="space-y-3">
          <div className="p-3 rounded-lg bg-[#0F1524] border border-[#1E293B] text-xs font-mono flex items-center justify-between">
            <div className="flex items-center space-x-2 text-slate-300">
              <Award className="w-4 h-4 text-amber-400" />
              <span className="font-bold">Pump.fun Official Top Caller Rankings</span>
              <span className="text-slate-500">• Verifiable on-chain track records</span>
            </div>

            <div className="text-[11px] text-slate-400">
              Toggle <span className="text-rose-400 font-bold">Auto-Snipe</span> to execute instant Jito MEV trades whenever that specific caller drops a callout
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-[#1E293B] bg-[#0A0E1A]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#0F1526] text-slate-400 border-b border-[#1E293B] uppercase text-[10px]">
                <tr>
                  <th className="py-2.5 px-3">Rank & Caller</th>
                  <th className="py-2.5 px-3">Win Rate (2x+)</th>
                  <th className="py-2.5 px-3">Avg Multiple</th>
                  <th className="py-2.5 px-3">Median Multiple</th>
                  <th className="py-2.5 px-3">Time to Peak</th>
                  <th className="py-2.5 px-3">Total Calls</th>
                  <th className="py-2.5 px-3">Top Hall-of-Fame Calls</th>
                  <th className="py-2.5 px-3 text-right">Auto-Snipe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E293B]">
                {leaderboard.map((caller, idx) => (
                  <tr key={`caller-${caller.userId}-${idx}`} className="hover:bg-[#111728] transition">
                    {/* Rank & Caller */}
                    <td className="py-3 px-3">
                      <div className="flex items-center space-x-2.5">
                        <span
                          className={`w-5 text-center font-bold font-mono text-xs ${
                            idx === 0
                              ? 'text-amber-400'
                              : idx === 1
                              ? 'text-slate-300'
                              : idx === 2
                              ? 'text-amber-600'
                              : 'text-slate-500'
                          }`}
                        >
                          #{idx + 1}
                        </span>

                        <img
                          src={caller.avatarUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=120&auto=format&fit=crop&q=80'}
                          alt={caller.userId}
                          className="w-7 h-7 rounded-full border border-slate-700 object-cover"
                        />

                        <div>
                          <div
                            onClick={() => setSelectedCallerModal(caller)}
                            className="font-bold text-white hover:text-cyan-400 cursor-pointer flex items-center space-x-1"
                          >
                            <span>@{caller.userId}</span>
                            <Eye className="w-3 h-3 text-slate-500" />
                          </div>
                          <div className="text-[10px] text-slate-500 truncate max-w-[110px]">
                            {caller.primaryWallet.slice(0, 6)}...{caller.primaryWallet.slice(-4)}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Win Rate 2x */}
                    <td className="py-3 px-3">
                      <span className="font-bold text-emerald-400 text-sm">{caller.winRate2x}%</span>
                      <div className="text-[10px] text-slate-500">1.2x: {caller.winRate1_2x}%</div>
                    </td>

                    {/* Avg Multiple */}
                    <td className="py-3 px-3">
                      <span className="font-extrabold text-amber-400 text-sm">{caller.avgMultiple}x</span>
                    </td>

                    {/* Median Multiple */}
                    <td className="py-3 px-3 text-slate-300">{caller.medianMultiple}x</td>

                    {/* Time to Peak */}
                    <td className="py-3 px-3 text-cyan-400 font-semibold">
                      {Math.round(caller.avgTimeToPeakMs / 60000)}m {Math.round((caller.avgTimeToPeakMs % 60000) / 1000)}s
                    </td>

                    {/* Total Calls */}
                    <td className="py-3 px-3 text-slate-300">{caller.totalCallouts}</td>

                    {/* Top Hall-of-Fame Calls */}
                    <td className="py-3 px-3">
                      <div className="flex items-center space-x-1.5 flex-wrap gap-1">
                        {caller.topCallouts.slice(0, 2).map((top, tIdx) => (
                          <span
                            key={`top-${top.calloutId || top.symbol}-${tIdx}`}
                            className="px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-500/40 text-[10px] font-mono text-emerald-300 flex items-center space-x-1"
                          >
                            <span className="font-bold">${top.symbol}</span>
                            <span className="text-amber-300 font-black">{top.multiple}x</span>
                          </span>
                        ))}
                      </div>
                    </td>

                    {/* Auto-Snipe Switch */}
                    <td className="py-3 px-3 text-right">
                      <button
                        onClick={() => handleToggleAutoSnipe(caller.userId)}
                        className={`px-3 py-1 rounded-lg text-xs font-mono font-bold transition border ${
                          caller.isAutoSnipeSubscribed
                            ? 'bg-rose-600 text-white border-rose-400 shadow-sm shadow-rose-500/30'
                            : 'bg-[#141B2D] text-slate-400 border-[#1E293B] hover:text-white hover:border-slate-700'
                        }`}
                      >
                        {caller.isAutoSnipeSubscribed ? 'AUTO-SNIPE ON' : 'OFF'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. AUTO-SNIPER STRATEGY RULES */}
      {/* ========================================================================= */}
      {subTab === 'RULES' && (
        <div className="p-5 rounded-xl bg-[#0D1220] border border-[#1E293B] space-y-4">
          <div className="flex items-center justify-between border-b border-[#1E293B] pb-3">
            <div>
              <h3 className="text-sm font-bold text-white font-mono">
                Autonomous Pump.fun Callout Sniper Parameters
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Automatically execute Jito MEV bundles when high-winrate callers or multi-caller confluence trigger.
              </p>
            </div>

            <button
              onClick={handleSaveRules}
              className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-mono font-bold transition flex items-center space-x-1.5 shadow-md shadow-cyan-950"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Save Strategy Rules</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs font-mono">
            {/* Rule 1: Min Caller 2x Win Rate */}
            <div className="p-3 rounded-lg bg-[#090D16] border border-[#1E293B] space-y-2">
              <label className="text-slate-300 font-bold block">
                Min Caller 2x+ Win Rate (%)
              </label>
              <input
                type="number"
                value={rules.minCallerWinRate2x}
                onChange={(e) =>
                  setRules({ ...rules, minCallerWinRate2x: parseFloat(e.target.value) || 0 })
                }
                step="1"
                min="10"
                max="90"
                className="w-full px-3 py-1.5 bg-[#0F1524] border border-[#1E293B] rounded text-white font-bold outline-none focus:border-cyan-500"
              />
              <span className="text-[10px] text-slate-500 block">
                Ignores callers whose historical 2x hit rate is below this threshold.
              </span>
            </div>

            {/* Rule 2: Min Avg Multiple */}
            <div className="p-3 rounded-lg bg-[#090D16] border border-[#1E293B] space-y-2">
              <label className="text-slate-300 font-bold block">
                Min Average Multiple (e.g. 4.0x)
              </label>
              <input
                type="number"
                value={rules.minAvgMultiple}
                onChange={(e) =>
                  setRules({ ...rules, minAvgMultiple: parseFloat(e.target.value) || 0 })
                }
                step="0.5"
                min="1.5"
                max="20"
                className="w-full px-3 py-1.5 bg-[#0F1524] border border-[#1E293B] rounded text-white font-bold outline-none focus:border-cyan-500"
              />
              <span className="text-[10px] text-slate-500 block">
                Requires caller average historical multiple to exceed this value.
              </span>
            </div>

            {/* Rule 3: Max Entry Price Multiple */}
            <div className="p-3 rounded-lg bg-[#090D16] border border-[#1E293B] space-y-2">
              <label className="text-slate-300 font-bold block">
                Max Entry Multiple (Chasing Guard)
              </label>
              <input
                type="number"
                value={rules.maxEntryMultiple}
                onChange={(e) =>
                  setRules({ ...rules, maxEntryMultiple: parseFloat(e.target.value) || 1 })
                }
                step="0.05"
                min="1.05"
                max="2.5"
                className="w-full px-3 py-1.5 bg-[#0F1524] border border-[#1E293B] rounded text-white font-bold outline-none focus:border-cyan-500"
              />
              <span className="text-[10px] text-slate-500 block">
                Aborts snipe if token has already pumped &gt; 1.35x from callout price to prevent dumping.
              </span>
            </div>

            {/* Rule 4: Max Elapsed Time */}
            <div className="p-3 rounded-lg bg-[#090D16] border border-[#1E293B] space-y-2">
              <label className="text-slate-300 font-bold block">
                Max Elapsed Callout Time (Seconds)
              </label>
              <input
                type="number"
                value={rules.maxElapsedSeconds}
                onChange={(e) =>
                  setRules({ ...rules, maxElapsedSeconds: parseInt(e.target.value) || 30 })
                }
                step="10"
                min="15"
                max="300"
                className="w-full px-3 py-1.5 bg-[#0F1524] border border-[#1E293B] rounded text-white font-bold outline-none focus:border-cyan-500"
              />
              <span className="text-[10px] text-slate-500 block">
                HFT prime entry window. Orders older than 60s are rejected.
              </span>
            </div>

            {/* Rule 5: Confluence Trigger */}
            <div className="p-3 rounded-lg bg-[#090D16] border border-[#1E293B] space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-slate-300 font-bold">
                  Auto-Snipe on 2x+ Confluence
                </label>
                <input
                  type="checkbox"
                  checked={rules.autoSnipeOnConfluence}
                  onChange={(e) =>
                    setRules({ ...rules, autoSnipeOnConfluence: e.target.checked })
                  }
                  className="w-4 h-4 rounded text-rose-600 bg-slate-800 border-slate-700"
                />
              </div>
              <span className="text-[10px] text-slate-500 block">
                Overrides individual caller thresholds if 2 or more verified callers call the same coin within 3 minutes.
              </span>
            </div>

            {/* Rule 6: Jito Tip */}
            <div className="p-3 rounded-lg bg-[#090D16] border border-[#1E293B] space-y-2">
              <label className="text-slate-300 font-bold block">
                Jito Priority Tip (SOL)
              </label>
              <input
                type="number"
                value={rules.jitoPriorityTipSol}
                onChange={(e) =>
                  setRules({ ...rules, jitoPriorityTipSol: parseFloat(e.target.value) || 0.00018 })
                }
                step="0.0001"
                min="0.00015"
                max="0.05"
                className="w-full px-3 py-1.5 bg-[#0F1524] border border-[#1E293B] rounded text-white font-bold outline-none focus:border-cyan-500"
              />
              <span className="text-[10px] text-slate-500 block">
                Direct tip to Jito MEV validators for slot leader front-running and anti-sandwich.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* CALLER PROFILE MODAL */}
      {selectedCallerModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0B0F19] border border-[#1E293B] rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between">
              <div className="flex items-center space-x-3">
                <img
                  src={selectedCallerModal.avatarUrl}
                  alt={selectedCallerModal.userId}
                  className="w-12 h-12 rounded-full border border-slate-700 object-cover"
                />
                <div>
                  <h4 className="text-base font-bold text-white font-mono">
                    @{selectedCallerModal.userId}
                  </h4>
                  <div className="flex items-center space-x-2 mt-0.5 mb-1">
                    <a
                      href={`https://x.com/${selectedCallerModal.userId.replace(/^@/, '')}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] font-mono text-sky-400 hover:text-sky-300 inline-flex items-center space-x-0.5"
                      title="View caller profile on 𝕏"
                    >
                      <span className="font-bold">𝕏 Profile</span>
                      <ExternalLink className="w-2.5 h-2.5 ml-0.5" />
                    </a>
                  </div>
                  <div className="text-xs font-mono text-slate-400 flex items-center space-x-1.5">
                    <span>Wallet: {selectedCallerModal.primaryWallet.slice(0, 10)}...{selectedCallerModal.primaryWallet.slice(-6)}</span>
                    <a
                      href={`https://solscan.io/account/${selectedCallerModal.primaryWallet}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-cyan-400 hover:text-cyan-300 inline-flex items-center"
                      title="View on Solscan"
                    >
                      <ExternalLink className="w-3 h-3 ml-0.5" />
                    </a>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40 mt-1 inline-block">
                    {selectedCallerModal.reputationTier}
                  </span>
                </div>
              </div>

              <button
                onClick={() => setSelectedCallerModal(null)}
                className="text-slate-400 hover:text-white p-1 rounded-lg bg-[#141B2D]"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs font-mono">
              <div className="p-2.5 rounded-lg bg-[#090D16] border border-[#1E293B]">
                <div className="text-[10px] text-slate-500">2x Win Rate</div>
                <div className="text-base font-bold text-emerald-400">
                  {selectedCallerModal.winRate2x}%
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#090D16] border border-[#1E293B]">
                <div className="text-[10px] text-slate-500">Avg Multiple</div>
                <div className="text-base font-bold text-amber-400">
                  {selectedCallerModal.avgMultiple}x
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#090D16] border border-[#1E293B]">
                <div className="text-[10px] text-slate-500">Avg Time to Peak</div>
                <div className="text-base font-bold text-cyan-400">
                  {Math.round(selectedCallerModal.avgTimeToPeakMs / 60000)}m
                </div>
              </div>
            </div>

            {/* Hall of fame calls */}
            <div>
              <h5 className="text-xs font-mono font-bold text-slate-300 uppercase mb-2">
                Top Historical Callouts
              </h5>
              <div className="space-y-1.5">
                {selectedCallerModal.topCallouts.map((c, mIdx) => (
                  <div
                    key={`modal-top-${c.calloutId || c.symbol}-${mIdx}`}
                    className="p-2 rounded bg-[#0E1424] border border-[#1E293B] flex items-center justify-between text-xs font-mono"
                  >
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-white">${c.symbol}</span>
                      <span className="text-slate-500 truncate max-w-[140px]">{c.coinMint}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-slate-400">Entry: ${Math.round(c.marketCapAtCall).toLocaleString()}</span>
                      <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-extrabold">
                        {c.multiple}x Peak
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Live Data vs Simulation Disclosure */}
            <div className="p-2.5 rounded-lg bg-[#090D16] border border-[#1E293B] text-[11px] font-mono space-y-1">
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-emerald-400 font-bold flex items-center space-x-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  <span>Discovery Feed: LIVE</span>
                </span>
                <span className="text-slate-300">Pump.fun + DexScreener</span>
              </div>
              <p className="text-slate-400 text-[10px] leading-relaxed">
                Tokens called by this profile are monitored on live DexScreener boosted queues. {tradingMode.live ? `LIVE is armed${tradingMode.cluster ? ` on ${tradingMode.cluster}` : ''}: a snipe from this profile sends a real transaction after you confirm it.` : tradingMode.known ? 'Mode is PAPER: a snipe from this profile is a simulated fill priced from the bonding curve.' : 'The server has not reported its mode, so this screen does not say whether a snipe is paper or live.'}
              </p>
            </div>

            <div className="pt-2 flex items-center justify-between">
              <button
                onClick={() => {
                  handleToggleAutoSnipe(selectedCallerModal.userId);
                  setSelectedCallerModal({
                    ...selectedCallerModal,
                    isAutoSnipeSubscribed: !selectedCallerModal.isAutoSnipeSubscribed,
                  });
                }}
                className={`w-full py-2 rounded-lg font-mono font-bold text-xs transition border ${
                  selectedCallerModal.isAutoSnipeSubscribed
                    ? 'bg-rose-600 text-white border-rose-500'
                    : 'bg-[#141B2D] text-slate-300 border-[#1E293B] hover:text-white'
                }`}
              >
                {selectedCallerModal.isAutoSnipeSubscribed
                  ? 'Auto-Snipe Subscribed (Click to Disable)'
                  : 'Subscribe to Auto-Snipe this Caller'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
