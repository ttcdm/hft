/**
 * The Pump.fun hot callouts board: callouts, callers and the callout rules, with a snipe button per callout.
 *
 * API it calls (through `engineClient`): `GET /api/pumpfun/callouts`, `POST /api/pumpfun/callouts/snipe`,
 * `GET` and `POST /api/pumpfun/callouts/rules`, `POST /api/pumpfun/refresh`. New callouts and
 * "sniped" notices arrive over the `/ws/engine` WebSocket.
 *
 * The callout rules are live: while the
 * Auto controller is not OFF, `pumpfunService.evaluateAutoSnipeTriggers` reads them and submits matching callouts to the controller as candidates
 * (the controller still applies its own gates and mode; in SHADOW nothing is sent). The snipe button is a real one-click buy through the server's
 * gates, and in LIVE it needs `confirmLive`. Explorer and market links are always offered on this screen, because the callouts come from the mainnet
 * pump.fun list (the call passes `true` for "token is mainnet data"); this build trades devnet and localnet only.
 */
import { dollarSymbol, displayName, displaySymbol } from '../utils/displayName';
import { useSnipeAmount, formatSol } from '../utils/snipeAmount';
import { ageText } from '../utils/freshness';
import { SnipeAmountControl } from './SnipeAmountControl';
import { CONFLUENCE_RULE_LABEL, CONFLUENCE_RULE_NOTE, CALLOUT_RULES_SCOPE_NOTE } from '../utils/calloutRuleText';
import { useTradingMode, snipeBlockedReason, liveClickWarning } from '../utils/tradingMode';
import { authorityBadge, authorityTone, holderPct } from '../utils/authorityBadge';
import React, { useState, useEffect, useRef } from 'react';
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
import { engineClient, useWsStreaming } from '../services/engineClient';
import { hftAudio } from '../utils/audio';
import { DecimalBox } from './DecimalBox';
import { DialogFrame } from './DialogFrame';
import { confirmLiveClick } from './ConfirmDialog';
import {
  sanitizeExternalUrl,
  sanitizeXProfileUrl,
  hostOfUrl,
  sanitizeTwitterUrl,
  sanitizeTelegramUrl,
  isMainnetCluster,
  calloutSnipeBlock,
  mainnetLinksAvailable,
  calloutSnipeLabel,
  calloutSendNote,
  formatCalloutMcap,
  solscanAccountUrl,
} from '../utils/tokenLinks';

interface PumpFunHotCalloutsViewProps {
  capitalTier?: 'MICRO_10' | 'INSTITUTIONAL';
  onAlertTrigger?: (level: 'INFO' | 'WARNING' | 'CRITICAL', title: string, message: string) => void;
  onRefreshParent?: () => void;
}

/** 3H: what the rules form holds after a poll. While the operator has unsaved edits, the poll leaves them alone (it used to replace them every 6 s). */
export function rulesAfterPoll<T>(current: T, fromServer: T, dirty: boolean): T {
  return dirty ? current : fromServer;
}

/**
 * 3H: the coin's own image, or an empty tile with its first letters. A missing or broken image used to show a stock photo as if it were the coin's.
 * R2-11: the image URL is the creator's, so loading it tells the creator's server the operator's IP and when they looked. It is not loaded
 * until the operator clicks the tile.
 */
export function TokenImage({ uri, symbol }: { uri: string; symbol: string }) {
  const [broken, setBroken] = useState(false);
  const [load, setLoad] = useState(false);
  if (uri && !broken && !load) {
    return (
      <button type="button" data-testid="token-image-click" onClick={() => setLoad(true)} title={`Load the creator-hosted image from ${hostOfUrl(uri) ?? 'an unknown host'} (your IP is visible to that host)`}
        className="w-11 h-11 rounded-lg border border-dashed border-slate-600 bg-slate-800 flex flex-col items-center justify-center flex-shrink-0 text-[9px] font-mono text-slate-400">
        <span>{symbol.slice(0, 3)}</span><span className="text-[8px] text-slate-500">img</span>
      </button>
    );
  }
  if (!uri || broken) {
    return (
      <div data-testid="token-image-missing" className="w-11 h-11 rounded-lg border border-slate-700 bg-slate-800 flex items-center justify-center flex-shrink-0 text-[10px] font-mono text-slate-400">
        {symbol.slice(0, 3)}
      </div>
    );
  }
  return <img src={uri} alt={symbol} className="w-11 h-11 rounded-lg border border-slate-700 object-cover flex-shrink-0" onError={() => setBroken(true)} />;
}

/** R6-10: what the callout action badge means. INSTANT_SNIPE used to read as a prime entry; it is the pump.fun list plus a paid boost. */
export function calloutActionLabel(a: string): string {
  return a === 'INSTANT_SNIPE' ? 'LISTED + BOOSTED' : a.replace(/_/g, ' ');
}
export function calloutActionTitle(a: string): string {
  return a === 'INSTANT_SNIPE'
    ? 'Near the top of the pump.fun HTTP list AND on DexScreener\'s paid boost list, multiple at most 2.5x and under 3 minutes old. A paid boost is promotion, not a verified signal.'
    : 'Derived from the pump.fun HTTP feed (curve %, market cap multiple, age).';
}
export const InventedCallerTag = () => (
  <span data-testid="invented-caller" title="DEMO_MODE=true: this caller and its stats are invented" className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-rose-950 text-rose-300 border border-rose-500/50">INVENTED (DEMO)</span>
);

/** R6-6: the age of the feed snapshot behind a callout card. Past CALLOUT_SNAPSHOT_MAX_AGE_MS the server's auto-snipe check skips it too. */
export const CALLOUT_SNAPSHOT_STALE_MS = 15_000;
export function CalloutSnapshotAge({ dataAsOfMs, now = Date.now() }: { dataAsOfMs?: number; now?: number }) {
  const stale = typeof dataAsOfMs !== 'number' || now - dataAsOfMs > CALLOUT_SNAPSHOT_STALE_MS;
  return (
    <div data-testid="callout-snapshot-age" title="Curve %, market cap, price and multiple on this card are from this snapshot" className={`px-2 py-1 rounded border text-[10px] font-mono ${stale ? 'border-amber-500/50 text-amber-300' : 'border-[#1E293B] text-slate-500'}`}>
      data {typeof dataAsOfMs === 'number' ? ageText(now - dataAsOfMs) : 'age unknown'}{stale ? ' (STALE)' : ''}
    </div>
  );
}

/** R10-7: a 1 s clock, so ages on this screen keep counting between feed syncs (they froze at the last snapshot's text). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

/** R10-7: the time since the token's last trade, counted from the callout's timestamp on this clock; the server's text only without one. */
export function calloutAgeText(calloutTimestamp: number | undefined, fallback: string, now: number): string {
  if (typeof calloutTimestamp !== 'number' || !Number.isFinite(calloutTimestamp) || calloutTimestamp <= 0) return fallback;
  const s = Math.max(0, Math.floor((now - calloutTimestamp) / 1000));
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

export function CalloutAge({ calloutTimestamp, fallback }: { calloutTimestamp?: number; fallback: string }) {
  const now = useNow();
  return <span data-testid="callout-age" title="Time since the token's last trade, counted on this screen">{calloutAgeText(calloutTimestamp, fallback, now)}</span>;
}

export function LiveCalloutSnapshotAge({ dataAsOfMs }: { dataAsOfMs?: number }) {
  const now = useNow();
  return <CalloutSnapshotAge dataAsOfMs={dataAsOfMs} now={now} />;
}

/** 3H (P3.7): the feed status as the server measures it. It used to be implied by fixed "Live ingest" text whether or not anything arrived. */
export function FeedStatusPill({ status }: { status: string | null }) {
  const tone =
    status === 'ONLINE' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
      : status === 'STALE' ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
        : 'bg-slate-700/40 text-slate-300 border-slate-600/50';
  // R10-7: this is the callout list's own sync, not the Pump.fun event feed System checks reports; say which
  const text = status === 'ONLINE' ? 'CALLOUT FEED ONLINE' : status === 'STALE' ? 'CALLOUT FEED STALE (no callout sync in the last minute; the Pump.fun event feed in System checks is separate)' : status === 'NO_DATA' ? 'NO FEED DATA YET' : 'CALLOUT FEED STATUS UNKNOWN';
  return <span data-testid="feed-status-pill" className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${tone}`}>{text}</span>;
}

export const PumpFunHotCalloutsView: React.FC<PumpFunHotCalloutsViewProps> = ({
  capitalTier = 'MICRO_10',
  onAlertTrigger,
  onRefreshParent,
}) => {
  const tradingMode = useTradingMode();
  const snipeBlocked = snipeBlockedReason(tradingMode); // UI report fix 7: grey the snipe buttons while the kill switch is on
  const snipeAmount = useSnipeAmount();
  const [subTab, setSubTab] = useState<'CALLOUTS' | 'LEADERBOARD' | 'RULES'>('CALLOUTS');
  const [callouts, setCallouts] = useState<PumpFunHotCallout[]>([]);
  const [leaderboard, setLeaderboard] = useState<PumpFunCaller[]>([]);
  const [statusInfo, setStatusInfo] = useState<{
    /** 3H: from the server's real feed activity (NO_DATA / ONLINE / STALE); null until it has answered */
    feedStatus: string | null;
    liveSource: string;
    syncLatencyMs: number;
    tokensTrackedCount: number;
    /** null until the server has reported a sync time; never invented from the browser clock (S19) */
    lastUpdated: number | null;
  }>({
    feedStatus: null,
    liveSource: '—',
    syncLatencyMs: 0,
    tokensTrackedCount: 0,
    lastUpdated: null,
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

  const rulesDirty = useRef(false); // true from the first edit until the server confirms a save
  const editRules = (patch: Partial<typeof rules>) => {
    rulesDirty.current = true;
    setRules((r) => ({ ...r, ...patch }));
  };

  const [activeFilter, setActiveFilter] = useState<'ALL' | 'CONFLUENCE' | 'TOP_WHALES' | 'FRESH' | 'MIGRATING'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedCa, setCopiedCa] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [snipingCalloutId, setSnipingCalloutId] = useState<string | null>(null);
  const [selectedCallerModal, setSelectedCallerModal] = useState<PumpFunCaller | null>(null);

  const isWsLive = useWsStreaming(); // R9-7: open, authenticated, online and not quiet, re-checked every second

  // Fetch callouts from backend (which polls real pump.fun & DexScreener)
  const fetchData = async () => {
    try {
      const data: PumpFunHotCalloutsResponse = await engineClient.getPumpFunCallouts();
      if (data && data.callouts) {
        setCallouts(data.callouts);
        setLeaderboard(data.leaderboard || []);
        setStatusInfo({
          feedStatus: data.feedStatus ?? null,
          liveSource: data.liveSource || '—',
          syncLatencyMs: data.syncLatencyMs ?? 0,
          tokensTrackedCount: data.tokensTrackedCount ?? 0,
          lastUpdated: data.lastUpdated || null,
        });
        // 3H: the 6 s poll no longer overwrites a rule the operator is editing; the server copy is taken again after a save
        if (data.autoSnipeRules) setRules((current) => rulesAfterPoll(current, data.autoSnipeRules, rulesDirty.current));
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchData();

    // Real-time WebSocket subscriptions
    const unsubHotCallouts = engineClient.onPumpHotCallouts((data) => {
      if (data.callouts) setCallouts(data.callouts);
      if (data.leaderboard) setLeaderboard(data.leaderboard);
      if (data.status) {
        setStatusInfo({
          feedStatus: data.status.status ?? null,
          liveSource: data.status.liveSource || '—',
          syncLatencyMs: data.status.syncLatencyMs ?? 0,
          tokensTrackedCount: data.status.tokensTrackedCount ?? 0,
          lastUpdated: data.status.lastSyncTimestamp || null,
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
          `⚡ AUTONOMOUS CALLOUT SNIPED: ${dollarSymbol(data.callout.token.symbol)}`,
          data.tradeRes?.message || `Snipe request handled for ${dollarSymbol(data.callout.token.symbol)}`
        );
        onRefreshParent?.();
      }
    });

    // Gentle polling fallback in case WS is interrupted
    const interval = setInterval(() => {
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
    const r = await engineClient.refreshPumpFunData();
    // Off mainnet the server fetches nothing (the HTTP feeds are mainnet-only) and says why
    if (r?.status === 'SKIPPED') onAlertTrigger?.('INFO', 'LIVE SYNC NOT RUN', String(r.reason ?? 'the HTTP feeds run on mainnet-beta only'));
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
    // S181: the size is the operator's saved snipe amount; an out-of-bounds value is refused here and again by the server
    if (!snipeAmount.parsed.ok) {
      onAlertTrigger?.('WARNING', 'SNIPE NOT SENT', snipeAmount.parsed.reason);
      return;
    }
    const amountSol = snipeAmount.parsed.sol;
    // Q10b: while LIVE is armed this click sends a real transaction; say so and ask first
    const warning = liveClickWarning(tradingMode, `Sniping ${dollarSymbol(callout.token.symbol)} for ${formatSol(amountSol)}`);
    if (warning && !(await confirmLiveClick(warning))) return;
    setSnipingCalloutId(callout.id);
    hftAudio.playOrderFill();

    const res = await engineClient.snipePumpFunCallout(
      callout.id,
      amountSol,
      rules.jitoPriorityTipSol,
      6.0,
      tradingMode.live
    );

    if (res?.status === 'OK' && res?.result?.success) {
      onAlertTrigger?.(
        'INFO',
        `⚡ HOT CALLOUT SNIPED: ${dollarSymbol(callout.token.symbol)}`,
        `${tradingMode.live ? 'Sent' : 'PAPER fill of'} ${formatSol(amountSol)} on Pump.fun (${tradingMode.label}). Caller: @${callout.caller.userId} (Avg: ${callout.caller.avgMultiple}x)`
      );
      setCallouts((prev) =>
        prev.map((c) => (c.id === callout.id ? { ...c, status: 'SNIPED' } : c))
      );
      onRefreshParent?.();
    } else {
      onAlertTrigger?.(
        'WARNING',
        'SNIPE REJECTED',
        res?.result?.message || res?.error || 'Failed pre-trade risk or curve check'
      );
    }
    setSnipingCalloutId(null);
  };

  const handleSaveRules = async () => {
    hftAudio.playClick();
    const res = await engineClient.updatePumpFunRules(rules);
    if (res?.status === 'OK') {
      rulesDirty.current = false;
      if (res.rules) setRules(res.rules);
      onAlertTrigger?.('INFO', 'AUTO-SNIPE RULES SAVED', 'Saved in server memory until the next restart.');
    } else {
      onAlertTrigger?.('WARNING', 'AUTO-SNIPE RULES NOT SAVED', `The server did not confirm the save${res?.error ? `: ${res.error}` : ''}; your edits are still on screen.`);
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
              {isWsLive && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 flex items-center space-x-1">
                  <Radio className="w-2.5 h-2.5 text-cyan-400 animate-pulse" />
                  <span>SCREEN UPDATES LIVE</span>
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-300 mt-0.5">
              <FeedStatusPill status={statusInfo.feedStatus} /> Ingest: <span className="font-mono text-cyan-300">{statusInfo.liveSource}</span> • {statusInfo.tokensTrackedCount} on-chain tokens monitored • Latency: <span className="font-mono text-emerald-400">{statusInfo.syncLatencyMs > 0 ? `${statusInfo.syncLatencyMs}ms` : '—'}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <div className="px-2.5 py-1 rounded bg-[#0A0E1A] border border-[#1E293B] text-[11px] font-mono text-slate-300 hidden md:block">
            Synced: <span className="text-white font-semibold">{statusInfo.lastUpdated ? new Date(statusInfo.lastUpdated).toLocaleTimeString() : '—'}</span>
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
            Showing <span className="text-white font-bold">{filteredCallouts.length}</span> hot calls
          </div>
        )}
      </div>
      {calloutSnipeBlock(tradingMode.cluster) !== null && (
        <div data-testid="callouts-mainnet-banner" className="mx-1 mb-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] font-mono text-amber-300">
          These callouts are pump.fun MAINNET data. This server is on {tradingMode.cluster || 'an unknown cluster'}, where these tokens do not exist, so they cannot be sniped here.
        </div>
      )}

      {/* ========================================================================= */}
      {/* 1. HOT CALLOUTS STREAM VIEW */}
      {/* ========================================================================= */}
      {subTab === 'CALLOUTS' && (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-[#0F172A] border border-cyan-500/20">
            <SnipeAmountControl />
          </div>

          {/* Quick Auto-Sniper Status Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-gradient-to-r from-[#0F172A] to-[#1E1B4B] border border-cyan-500/30 shadow-lg">
            <div className="flex items-center space-x-2.5">
              <Bot className="w-5 h-5 text-cyan-400 animate-pulse" />
              <div>
                <div className="text-xs font-mono font-bold text-white flex items-center space-x-2">
                  <span>PUMP.FUN CALLOUTS</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    CALLOUTS
                  </span>
                </div>
                <div className="text-[11px] text-slate-400">
                  Marking a caller only flags them on this screen; nothing buys because of it. Auto trading is controlled in the Auto panel.
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
                <span>Caller leaderboard</span>
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
                            {c.caller.invented && <InventedCallerTag />}

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
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-black bg-rose-500 text-white shadow-sm flex items-center space-x-1">
                                <Sparkles className="w-3 h-3" />
                                <span title="Counted from the pump.fun HTTP list position, DexScreener's PAID boost list and 5-minute order flow; not from independent callers">{c.confluenceCount} feed signals (incl. paid DexScreener boost)</span>
                              </span>
                            )}
                          </div>

                          <div className="text-[10px] font-mono text-slate-400 flex items-center space-x-2 mt-0.5">
                            <span>
                              {c.caller.invented ? 'Invented win rate (2x+): ' : 'Win Rate (2x+): '}<span className="text-emerald-400 font-bold">{c.caller.winRate2x}%</span>
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
                          <span title={calloutActionTitle(c.hftAction)}>{calloutActionLabel(c.hftAction)}</span>
                        </div>

                        {/* Time elapsed */}
                        <div className="px-2 py-1 rounded bg-[#090D16] border border-[#1E293B] text-[11px] font-mono text-slate-300 flex items-center space-x-1">
                          <Clock className="w-3 h-3 text-slate-500" />
                          <CalloutAge calloutTimestamp={c.calloutTimestamp} fallback={c.token.timeAgoStr} />
                        </div>
                        {/* R6-6: curve %, market cap, price and multiple are a snapshot; say how old */}
                        <LiveCalloutSnapshotAge dataAsOfMs={c.dataAsOfMs} />
                      </div>
                    </div>

                    {/* MAIN TOKEN ROW: LOGO, SYMBOL, CA, BONDING CURVE, PRICING */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
                      {/* TOKEN IDENTITY (Cols 1-4) */}
                      <div className="lg:col-span-4 flex items-start space-x-3">
                        <TokenImage uri={c.token.imageUri} symbol={displaySymbol(c.token.symbol)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center space-x-2">
                            <span className="font-extrabold text-white text-sm tracking-wide font-sans">
                              {dollarSymbol(c.token.symbol)}
                            </span>
                            <span className="text-xs text-slate-400 truncate max-w-[120px]">
                              {displayName(c.token.name)}
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
                            {mainnetLinksAvailable(tradingMode.cluster, true /* S184: callouts come from the mainnet pump.fun list */) ? (
                              <>
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
                            <a
                              href={`https://solscan.io/token/${c.token.mint}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate-400 hover:text-slate-200 p-0.5 text-[9px] font-mono flex items-center gap-0.5"
                              title="Solscan (mainnet token page)"
                            >
                              <span className="text-slate-300 font-bold">SCAN</span>
                            </a>
                              </>
                            ) : (
                              <span className="text-slate-600 p-0.5 text-[9px] font-mono" title={`Mainnet-only sites (pump.fun, DexScreener, GMGN) do not list this token${tradingMode.cluster ? ` on ${tradingMode.cluster}` : ' (cluster unknown)'}`}>no mainnet links</span>
                            )}

                            {/* Verified X.com Link */}
                            {(() => {
                              const twitterUrl = sanitizeTwitterUrl(c.token.twitter, c.token.symbol, true);
                              // Round 1 #12 / R2-11: the handle is the creator's own claim, and only an x.com / twitter.com link is followed
                              const hasOfficial = Boolean(sanitizeXProfileUrl(c.token.twitter));
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
                                  title={hasOfficial ? `𝕏 handle supplied by the token creator (unverified): ${twitterUrl}` : `Search ${dollarSymbol(c.token.symbol)} on 𝕏`}
                                >
                                  <span className="font-bold">𝕏</span>
                                  {hasOfficial && <span className="text-[8px] uppercase">creator-supplied</span>}
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
                                  title={`Telegram (creator-supplied, unverified): ${tgUrl}`}
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
                                  title={`Website (creator-supplied, unverified, goes to ${hostOfUrl(webUrl) ?? 'an unknown host'}): ${webUrl}`}
                                >
                                  <Globe className="w-2.5 h-2.5" />
                                  <span className="text-[8px]">{hostOfUrl(webUrl) ?? '?'}</span>
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
                            const b = authorityBadge('Mint', c.token.isMintRevoked as boolean | null, 'the pump.fun feed');
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
                          <div className="text-[10px] text-slate-500 uppercase" title="Market cap the first time this server saw the token as a callout. It is not the launch market cap.">Mcap when first seen</div>
                          <div className="font-bold text-slate-300" data-testid="callout-mcap">
                            {formatCalloutMcap(c.token.marketCapAtCalloutUsd)}
                          </div>
                        </div>

                        <div className="p-2 rounded bg-[#090D16] border border-[#1E293B]">
                          <div className="text-[10px] text-slate-500 uppercase">Multiple since first seen</div>
                          {c.token.currentMultiple === null ? (
                            <div className="font-bold text-slate-500" data-testid="callout-multiple">unknown</div>
                          ) : (
                            <div className="font-extrabold text-emerald-400 flex items-center space-x-0.5" data-testid="callout-multiple">
                              <ArrowUpRight className="w-3 h-3" />
                              <span>{c.token.currentMultiple.toFixed(2)}x</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 1-CLICK SNIPE ACTION (Cols 11-12) */}
                      <div className="lg:col-span-2 flex flex-col space-y-1.5">
                        <button
                          onClick={() => handleSnipeCallout(c)}
                          disabled={snipingCalloutId === c.id || c.status === 'SNIPED' || calloutSnipeBlock(tradingMode.cluster) !== null || snipeBlocked !== null}
                          title={calloutSnipeBlock(tradingMode.cluster) ?? snipeBlocked ?? undefined}
                          className={`disabled:opacity-40 disabled:cursor-not-allowed w-full py-2 px-3 rounded-lg font-mono font-bold text-xs transition flex items-center justify-center space-x-1.5 shadow-md ${
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
                              : calloutSnipeBlock(tradingMode.cluster) !== null
                              ? 'MAINNET ONLY'
                              : calloutSnipeLabel(snipeAmount.parsed.ok ? formatSol(snipeAmount.parsed.sol) : 'set amount')}
                          </span>
                        </button>

                        {calloutSnipeBlock(tradingMode.cluster) !== null ? (
                          <div data-testid="callout-mainnet-note" className="text-center text-[10px] font-mono text-amber-400/80">
                            Mainnet data: this token does not exist on {tradingMode.cluster || 'this cluster'}
                          </div>
                        ) : (
                          <div className="text-center text-[10px] font-mono text-slate-500">
                            {calloutSendNote(rules.jitoPriorityTipSol)}
                          </div>
                        )}
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
                          <span>{c.caller.invented ? 'Also "called" by (invented DEMO callers):' : 'Also called by:'}</span>
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
              <span className="font-bold">Caller leaderboard</span>
              {leaderboard.some((c) => c.invented) ? (
                <span data-testid="leaderboard-invented" className="text-rose-300 font-bold">• DEMO_MODE: these callers and their win rates are INVENTED, not real track records</span>
              ) : (
                <span className="text-slate-500">• no caller source is wired; this list is empty outside DEMO_MODE</span>
              )}
            </div>

            <div className="text-[11px] text-slate-400">
              <span className="text-rose-400 font-bold">Mark</span> a caller to flag them on this screen. Marking does not buy anything; auto trading is controlled in the Auto panel.
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
                            <span className="font-bold">{dollarSymbol(top.symbol)}</span>
                            <span className="text-amber-300 font-black">{top.multiple}x</span>
                          </span>
                        ))}
                      </div>
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
                {CALLOUT_RULES_SCOPE_NOTE}
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
              <DecimalBox testId="rule-minCallerWinRate2x" ariaLabel="Min caller 2x+ win rate (%)" value={rules.minCallerWinRate2x} onValue={(n) => editRules({ minCallerWinRate2x: n })}
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
              <DecimalBox testId="rule-minAvgMultiple" ariaLabel="Min average multiple" value={rules.minAvgMultiple} onValue={(n) => editRules({ minAvgMultiple: n })}
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
              <DecimalBox testId="rule-maxEntryMultiple" ariaLabel="Max entry multiple" value={rules.maxEntryMultiple} onValue={(n) => editRules({ maxEntryMultiple: n })}
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
              <DecimalBox testId="rule-maxElapsedSeconds" ariaLabel="Max elapsed callout time (seconds)" value={rules.maxElapsedSeconds} onValue={(n) => editRules({ maxElapsedSeconds: n })} integer
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
                  {CONFLUENCE_RULE_LABEL}
                </label>
                <input
                  type="checkbox"
                  checked={rules.autoSnipeOnConfluence}
                  onChange={(e) =>
                    editRules({ autoSnipeOnConfluence: e.target.checked })
                  }
                  className="w-4 h-4 rounded text-rose-600 bg-slate-800 border-slate-700"
                />
              </div>
              <span className="text-[10px] text-slate-500 block">
                {CONFLUENCE_RULE_NOTE}
              </span>
            </div>

            {/* Rule 6: Jito Tip */}
            <div className="p-3 rounded-lg bg-[#090D16] border border-[#1E293B] space-y-2">
              <label className="text-slate-300 font-bold block">
                Jito Priority Tip (SOL)
              </label>
              <DecimalBox testId="rule-jitoPriorityTipSol" ariaLabel="Jito priority tip (SOL)" value={rules.jitoPriorityTipSol} onValue={(n) => editRules({ jitoPriorityTipSol: n })}
                className="w-full px-3 py-1.5 bg-[#0F1524] border border-[#1E293B] rounded text-white font-bold outline-none focus:border-cyan-500"
              />
              <span className="text-[10px] text-slate-500 block">
                Tip paid to Jito validators with a LIVE bundle. PAPER sends nothing and pays no tip.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* CALLER PROFILE MODAL */}
      {selectedCallerModal && (
        <DialogFrame label="Caller profile" className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
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
                    {solscanAccountUrl(selectedCallerModal.primaryWallet, tradingMode.cluster) ? (
                    <a
                      href={solscanAccountUrl(selectedCallerModal.primaryWallet, tradingMode.cluster) as string}
                      target="_blank"
                      rel="noreferrer"
                      className="text-cyan-400 hover:text-cyan-300 inline-flex items-center"
                      title="View on Solscan"
                    >
                      <ExternalLink className="w-3 h-3 ml-0.5" />
                    </a>
                    ) : null}
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
                      <span className="font-bold text-white">{dollarSymbol(c.symbol)}</span>
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
          </div>
        </DialogFrame>
      )}
    </div>
  );
};
