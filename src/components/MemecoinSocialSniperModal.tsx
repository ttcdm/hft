/**
 * The "Memecoin and Social Sniper" screen: social signals, memecoin pools, open sniper positions, the sniper configuration and the Telegram
 * settings, with the Pump.fun hot callouts as an embedded tab (`PumpFunHotCalloutsView`).
 *
 * API it calls (all through `engineClient`, with the operator token): `GET /api/social/signals`, `POST /api/social/signals/snipe`,
 * `GET /api/memecoins/pools`, `GET /api/memecoins/positions`, `POST /api/memecoins/trade`, `POST /api/memecoins/close`,
 * `GET` and `POST /api/memecoins/config`, `/api/telegram/config`, `/api/telegram/test-connection`, `/api/telegram/webhook`, and
 * `GET /api/connectivity/diagnostics`. Live updates arrive over the `/ws/engine` WebSocket (pool snapshots, sniper trades).
 *
 * It holds no keys and decides nothing about risk: every buy goes to the server, which applies the gates described in
 * `docs/ARCHITECTURE.md`. While LIVE is armed the server refuses a snipe that does not carry `confirmLive`, and this screen only sends it
 * after the operator accepts the warning. Some switches here are stored but change nothing (KNOWN_RISKS.md section 6).
 */
import { dollarSymbol, displayName, displaySymbol } from '../utils/displayName';
import { signalFeedBadge } from '../utils/signalBadge';
import { useEscapeToClose } from '../utils/useEscapeToClose';
import { usePolled } from '../utils/usePolled';
import { probeBadge, probeBadgeClass, probeLatency, hostOfService, connectivityAuditSummary } from '../utils/probeBadge';
import { useTradingMode, snipeBlockedReason, liveClickWarning } from '../utils/tradingMode';
import { useAutoStatus, AutoModeBadge, type AutoMode } from './AutoPanel';
import { buildPoolSnipeRequest } from '../utils/poolSnipe';
import { useSnipeAmount, formatSol } from '../utils/snipeAmount';
import { SnipeAmountControl } from './SnipeAmountControl';
import { mainnetLinksAvailable, isMainnetDataProvenance, sanitizeXProfileUrl, sanitizeTelegramUrl, formatPctChange } from '../utils/tokenLinks';
import { authorityBadge, authorityTone, holderPct } from '../utils/authorityBadge';
import React, { useState, useEffect, useRef } from 'react';
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
import { engineClient, useWsStreaming } from '../services/engineClient';
import { fmtRank, fmtSmall, fmtUsdPrice } from '../utils/numFormat';
import { sellConfirmText } from '../utils/sellConfirm';
import { closeOutcomeTitle } from '../utils/closeOutcome';
import { hftAudio } from '../utils/audio';
import { PumpFunHotCalloutsView } from './PumpFunHotCalloutsView';
import { TokenInlineExternalLinks, TokenExternalLinksModal } from './TokenExternalLinksView';
import { BELOW_HEADER_TOP } from '../utils/headerOffset';
import { DecimalBox } from './DecimalBox';
import { DialogFrame, KILL_SWITCH_ID } from './DialogFrame';
import { askConfirm, confirmLiveClick, confirmSell } from './ConfirmDialog';
import { CONSOLE_PANIC_CONFIRM_TEXT, isConsoleEmergencyCommand } from '../utils/tradingCopy';

/**
 * P1.4 (N-12): the sniper tab's header. The auto mode shown is the auto controller's own (GET /api/auto/status), read-only: the
 * controller is the only thing that buys automatically, from watch-window releases of pump.fun launches, and its mode is set in the
 * Auto panel. This used to be an "Auto-Sniper ARMED/DISARMED" switch that flipped a flag only the aggregator callout loop reads, so
 * "DISARMED" was shown while DEVNET_LIVE kept buying.
 */
export function SniperAutoHeader({ autoMode, halted }: { autoMode: AutoMode | null; halted?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1E293B] pb-3" data-testid="sniper-auto-header">
      <div className="flex items-center space-x-2">
        <Bot className="w-5 h-5 text-cyan-400" />
        <div>
          <h3 className="text-sm font-bold text-white">Auto sniper (pump.fun watch window)</h3>
          <p className="text-xs text-slate-400">
            Auto buys come only from watch-window releases (HOT or READY) of new pump.fun launches on Solana, through the auto controller&apos;s gates. No Raydium, no Base, no social-signal auto trades.
          </p>
        </div>
      </div>
      <div className="flex items-center space-x-2">
        <span className="text-xs font-mono text-slate-300">Auto mode:</span>
        <AutoModeBadge mode={autoMode} halted={halted} />
        <span className="text-[10px] text-slate-500 font-mono" data-testid="sniper-auto-pointer">read-only: change it in the Auto panel on the home screen</span>
      </div>
    </div>
  );
}

/** The fixed exit rules as GET /api/memecoins/config reports them (server/exits/exitEngine.ts exitRulesSummary). */
export interface ExitRulesData {
  stopLossPct: number;
  trailingStartPct: number;
  trailingBelowHighPct: number;
  takeProfit: Array<{ atPct: number; sellPct: number }>;
  finalTrailBelowHighPct: number;
  staleAfterMinutes: number;
  staleBelowPct: number;
}

export function formatExitRules(r: ExitRulesData): string {
  const tps = r.takeProfit.map((t) => `sell ${t.sellPct}% at +${t.atPct}%`).join(', ');
  return `Exits (fixed): stop ${r.stopLossPct}%, trailing stop ${r.trailingBelowHighPct}% below the high from +${r.trailingStartPct}%, ${tps}, then trail ${r.finalTrailBelowHighPct}% below the high; sell all after ${r.staleAfterMinutes} min under +${r.staleBelowPct}%`;
}

/**
 * The exit rules every position follows. This used to read "Auto TP / Auto SL" from the sniper config, numbers no exit ever used;
 * the real rules are ExitEngine's constants, sent by the server.
 */
export function ExitRulesNote({ rules }: { rules: ExitRulesData | null }) {
  return (
    <span className="text-slate-500 hidden sm:inline text-[11px]" data-testid="exit-rules-note">
      {rules ? formatExitRules(rules) : 'Exit rules not loaded from the server'}
    </span>
  );
}

/**
 * 3H (A3): what the Jito card and the tip field say, from the Jito status readiness reports. With no block engine (the devnet and localnet
 * default) the coordinator forces the LIVE tip to 0 (resolveLiveTip), so the tip typed here is not paid on LIVE.
 */
export function jitoUseText(jitoStatus: string | null | undefined): { card: string; tipLabel: string } {
  if (!jitoStatus) return { card: 'status not loaded', tipLabel: 'Jito Tip (SOL) (Jito status not loaded)' };
  if (jitoStatus === 'NOT_CONFIGURED') return { card: 'off: no block engine, LIVE tip is 0', tipLabel: 'Jito Tip (SOL) (not paid on LIVE: Jito is off)' };
  return { card: `block engine ${jitoStatus}`, tipLabel: 'Jito Tip (SOL)' };
}

/** What the Telegram "Save Config" click reports, from the server's answer (it used to say "saved securely" without waiting for one). */
export function telegramSaveOutcome(res: any): { level: 'INFO' | 'WARNING'; title: string; message: string } {
  if (res?.status === 'OK') {
    const tokenNote = res.config?.botTokenSet ? 'a bot token is set' : 'no bot token is set';
    return { level: 'INFO', title: 'TELEGRAM SETTINGS SAVED', message: `Saved in server memory until the next restart; ${tokenNote}. No alerts are sent automatically.` };
  }
  return { level: 'WARNING', title: 'TELEGRAM SETTINGS NOT SAVED', message: `The server did not confirm the save${res?.error ? `: ${res.error}` : ''}.` };
}

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
  const [exitRules, setExitRules] = useState<ExitRulesData | null>(null);
  const [sniperConfig, setSniperConfig] = useState<SniperBotConfig>({
    isAutoSnipeEnabled: false,
    defaultSnipeAmountUsd: capitalTier === 'MICRO_10' ? 5.0 : 50.0,
    maxSlippagePct: 8.0,
    jitoTipSol: 0.005,
    takeProfitPct: 50.0,
    stopLossPct: 20.0,
    trailingStopEnabled: true,
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
  const snipeAmount = useSnipeAmount(); // S181: one saved size for every snipe button here
  const [manualSnipeLoading, setManualSnipeLoading] = useState(false);

  // Telegram interactive terminal
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalHistory, setTerminalHistory] = useState<Array<{ sender: 'USER' | 'BOT'; text: string; time: string }>>([
    {
      sender: 'BOT',
      text: '🤖 Local command console for the Telegram command handler. It does not read Telegram or X.com; commands typed here run on this server.\nType /help or /signals.',
      time: new Date().toLocaleTimeString(),
    },
  ]);

  // Real-time external connection testing & diagnostics state
  const [isTestingTelegram, setIsTestingTelegram] = useState(false);
  const [telegramTestResult, setTelegramTestResult] = useState<any | null>(null);
  const [sendPingMsg, setSendPingMsg] = useState(false);
  const [isTestingDiagnostics, setIsTestingDiagnostics] = useState(false);
  const tradingMode = useTradingMode();
  const snipeBlocked = snipeBlockedReason(tradingMode); // UI report fix 7: grey the snipe buttons while the kill switch is on
  const autoStatus = useAutoStatus(); // P1.4 (N-12): the sniper tab mirrors the auto controller's mode; it does not set it
  // 3H (A3): the Jito card and tip label say what the transport does, from GET /api/execution/readiness
  const readiness = usePolled<{ components?: { jito?: { status?: string } } }>('/api/execution/readiness', 15_000, isOpen);
  const jitoStatus = readiness.data?.components?.jito?.status ?? null;
  // 3H: the Telegram fields have their own state. In sniperConfig they were wiped by every config snapshot (the server never sends the token back).
  const [telegramDraft, setTelegramDraft] = useState({ botToken: '', chatId: '' });
  const [diagnosticsResult, setDiagnosticsResult] = useState<any | null>(null);
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false);

  const handleTestTelegram = async () => {
    setIsTestingTelegram(true);
    try {
      const res = await engineClient.testTelegramConnection(
        telegramDraft.botToken,
        telegramDraft.chatId,
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
      const summary = connectivityAuditSummary(res);
      onAlertTrigger?.(summary.level, summary.title, summary.message);
    } catch (e: any) {
      onAlertTrigger?.('CRITICAL', 'DIAGNOSTICS ERROR', e.message);
    } finally {
      setIsTestingDiagnostics(false);
    }
  };

  const isWsLive = useWsStreaming(); // R9-7: open, authenticated, online and not quiet, re-checked every second
  const [signalsRead, setSignalsRead] = useState<'pending' | 'ok' | 'failed'>('pending');

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
      // R9-6: a refused read (401) is "not read", never "0 Live"
      if (sigData?.status !== 'ERROR' && Array.isArray(sigData?.signals)) { setSignals(sigData.signals); setSignalsRead('ok'); } else setSignalsRead('failed');

      const poolData = await engineClient.getMemecoinPools(selectedPlatform, selectedChain);
      if (poolData?.pools) setPools(deduplicatePools(poolData.pools));

      const posData = await engineClient.getSniperPositions();
      if (posData?.positions) setPositions(posData.positions);

      const cfgData = await engineClient.getSniperConfig();
      if (cfgData?.config) setSniperConfig(cfgData.config);
      if (cfgData?.exitRules) setExitRules(cfgData.exitRules);
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
      if (data.pools) setPools(deduplicatePools(data.pools));
      if (data.positions) setPositions(data.positions);
      if (data.config) setSniperConfig(data.config);
    });

    const unsubTrade = engineClient.onSniperTrade((data) => {
      if (data?.position) {
        onAlertTrigger?.('INFO', '⚡ SNIPER TRADE EXECUTED', data.message || `Snipe filled for ${dollarSymbol(data.position.tokenTicker)}`);
        refreshData();
      }
    });

    const interval = setInterval(() => {
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
    if (!snipeAmount.parsed.ok) { onAlertTrigger?.('WARNING', 'SNIPE NOT SENT', snipeAmount.parsed.reason); return; }
    const amount = snipeAmount.parsed.sol;
    // Q10b: while LIVE is armed this click sends a real transaction; say so and ask first
    const warning = liveClickWarning(tradingMode, `Sniping ${dollarSymbol(sig.tokenTicker)} for ${formatSol(amount)}`);
    if (warning && !(await confirmLiveClick(warning))) return;
    hftAudio.playOrderFill();
    const res = await engineClient.snipeSocialSignal(sig.id, amount, sniperConfig.jitoTipSol, sniperConfig.maxSlippagePct, tradingMode.live);
    
    if (res?.tradeResult?.success) {
      onAlertTrigger?.(
        'INFO',
        `SNIPED ${dollarSymbol(sig.tokenTicker)}`,
        `${/^PAPER/i.test(String(res.tradeResult.txHash ?? '')) ? 'Paper fill' : 'Sent'} for ${formatSol(amount)} on ${sig.chain}${res.tradeResult.txHash ? ` (${String(res.tradeResult.txHash).slice(0, 14)}...)` : ''}. CA: ${sig.contractAddress.slice(0, 10)}...`
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
        res?.tradeResult?.message || res?.error || 'Failed pre-trade risk check'
      );
    }
  };

  // Snipe a pool row by its mint. The row never had a server-side signal, so it must not go through /api/social/signals/snipe
  // (that route looks the signal id up and answers "Signal not found" for an id the server never issued).
  const handleSnipePool = async (pool: MemecoinPool) => {
    if (!snipeAmount.parsed.ok) { onAlertTrigger?.('WARNING', 'SNIPE NOT SENT', snipeAmount.parsed.reason); return; }
    const amount = snipeAmount.parsed.sol;
    const warning = liveClickWarning(tradingMode, `Sniping ${dollarSymbol(pool.symbol)} for ${formatSol(amount)}`);
    if (warning && !(await confirmLiveClick(warning))) return;
    hftAudio.playOrderFill();
    const res = await engineClient.executeMemecoinSnipe(buildPoolSnipeRequest(pool, amount, sniperConfig), tradingMode.live);
    const r = res?.result ?? res?.tradeResult;
    if (r?.success) {
      onAlertTrigger?.(
        'INFO',
        `SNIPED ${dollarSymbol(pool.symbol)}`,
        `${/^PAPER/i.test(String(r.txHash ?? '')) ? 'Paper fill' : 'Sent'} for ${formatSol(amount)} on ${pool.chain}${r.txHash ? ` (${String(r.txHash).slice(0, 14)}...)` : ''}. CA: ${pool.contractAddress.slice(0, 10)}...`
      );
      refreshData();
    } else {
      onAlertTrigger?.('WARNING', 'SNIPE REJECTED', r?.message || res?.error || 'Failed pre-trade risk check');
    }
  };

  // Close / Take profit on open position
  const handleClosePosition = async (posId: string, sellPct: number = 100) => {
    // R9-5: a sell asks first, with what it sells
    const pos = positions.find((p) => p.id === posId);
    const ask = sellConfirmText({
      name: pos ? dollarSymbol(pos.tokenTicker) : 'this position', sellPct, mode: pos?.executionMode,
      tokensHeld: pos?.quantityTokens, valueText: pos && Number.isFinite(pos.currentValueUsd) ? `$${pos.currentValueUsd.toFixed(2)}` : null,
    });
    if (!(await confirmSell(ask))) return;
    hftAudio.playOrderFill();
    const res = await engineClient.closeSniperPosition(posId, sellPct);
    if (res?.result?.success) {
      // R13-8: the title follows what the close did (R6-9 outcome), not just the percentage asked for
      const r = res.result;
      const done = closeOutcomeTitle({ success: true, status: r.status, outcome: r.outcome }, sellPct);
      onAlertTrigger?.(done.severity, done.title, r.message);
      refreshData();
    } else {
      // R29: a refused close used to vanish silently
      onAlertTrigger?.('WARNING', 'CLOSE NOT DONE', res?.result?.message || res?.error || 'The server did not close the position.');
    }
  };

  // Send terminal message
  // R13-7: /panic_sell and /dump_all run the full emergency stop on the server; they ask first in the in-page confirm (Enter cannot
  // accept it), and while one is being confirmed or is out, another Enter does not send a second one.
  const consolePanicBusy = useRef(false);
  const handleSendTerminal = async () => {
    if (!terminalInput.trim()) return;
    const text = terminalInput.trim();
    if (isConsoleEmergencyCommand(text)) {
      if (consolePanicBusy.current) return;
      consolePanicBusy.current = true;
      try {
        if (!(await askConfirm({ title: 'EMERGENCY STOP', body: CONSOLE_PANIC_CONFIRM_TEXT(text), confirmLabel: 'Run the emergency stop' }))) return;
        await sendTerminal(text);
      } finally { consolePanicBusy.current = false; }
      return;
    }
    await sendTerminal(text);
  };
  const sendTerminal = async (text: string) => {
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
    // S1: a manual snipe by address is a one-click trade too
    if (!snipeAmount.parsed.ok) { onAlertTrigger?.('WARNING', 'SNIPE NOT SENT', snipeAmount.parsed.reason); return; }
    const warning = liveClickWarning(tradingMode, `Sniping ${manualSnipeCa.trim().slice(0, 8)}… for ${formatSol(snipeAmount.parsed.sol)}`);
    if (warning && !(await confirmLiveClick(warning))) return;
    setManualSnipeLoading(true);
    hftAudio.playOrderFill();
    try {
      const res = await engineClient.executeMemecoinSnipe({
        contractAddress: manualSnipeCa.trim(),
        amountSol: snipeAmount.parsed.sol,
        jitoTipSol: sniperConfig.jitoTipSol,
        slippagePct: sniperConfig.maxSlippagePct,
      }, tradingMode.live);

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

  useEscapeToClose(isOpen, onClose);
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
    <DialogFrame label="Memecoin social sniper" className={`fixed ${BELOW_HEADER_TOP} inset-x-0 bottom-0 z-40 flex items-start justify-center bg-black/85 backdrop-blur-md p-2 sm:p-4 overflow-y-auto`} alsoReach={[KILL_SWITCH_ID]}>
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
                  Telegram & X Signals and Memecoin Sniper
                </h2>
                {isWsLive && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 flex items-center space-x-1">
                    <Radio className="w-3 h-3 text-cyan-400 animate-pulse" />
                    <span>WS STREAMING</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Aggregating Pump.fun, Raydium, DexScreener and Uniswap/Base signals. Orders run through the execution engine in the mode shown in the banner; PAPER sends nothing.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <SnipeAmountControl compact />


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
            <span className="font-bold text-cyan-300" data-testid="signals-count">{signalsRead === 'failed' ? 'not read' : signalsRead === 'pending' ? '—' : `${signals.length} Live`}</span>
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
              <span>Jito bundles</span>
            </span>
            {/* UI-7: this card used to read "Jito MEV Protection 0.005 SOL Tip (Direct Slot)" on every cluster. 3H: it then said Jito is used on
                mainnet-beta only, which is not the rule; it now shows the transport readiness reports. */}
            <span className="font-bold text-purple-300" data-testid="jito-card">{jitoUseText(jitoStatus).card}</span>
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
                            <span className="font-bold text-cyan-300 text-sm">{dollarSymbol(sig.tokenTicker)}</span>
                            <span className="text-slate-500 truncate max-w-[220px]">({displayName(sig.tokenName)})</span>
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
                            {mainnetLinksAvailable(tradingMode.cluster, isMainnetDataProvenance(sig.provenance)) ? (
                              <>
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
                              </>
                            ) : (
                              <span className="text-slate-600 text-[10px] font-mono" title="Mainnet-only sites do not list this token unless the server is on mainnet">no mainnet links</span>
                            )}

                            {/* X.com Link */}
                            <a
                              href={
                                sanitizeXProfileUrl(sig.socials?.twitter) ||
                                (sig.source === 'X_TWITTER' && sig.authorHandle.startsWith('@')
                                  ? `https://x.com/${sig.authorHandle.replace('@', '')}`
                                  : `https://x.com/search?q=%24${sig.tokenTicker.replace('$', '')}+solana`)
                              }
                              target="_blank"
                              rel="noreferrer"
                              className="px-2 py-0.5 rounded bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 text-[10px] font-mono flex items-center space-x-1 transition"
                              title={
                                sanitizeXProfileUrl(sig.socials?.twitter)
                                  ? `Token X link (creator-supplied, unverified): ${sanitizeXProfileUrl(sig.socials?.twitter)}`
                                  : sig.source === 'X_TWITTER'
                                  ? `View Author @${sig.authorHandle} on X`
                                  : `Search ${dollarSymbol(sig.tokenTicker)} on X.com`
                              }
                            >
                              <span className="font-bold text-[11px]">𝕏</span>
                              <span>{sanitizeXProfileUrl(sig.socials?.twitter) ? 'Token 𝕏' : sig.source === 'X_TWITTER' ? 'KOL 𝕏' : 'Search 𝕏'}</span>
                              <ExternalLink className="w-2 h-2 text-sky-400" />
                            </a>

                            {/* Telegram Link */}
                            {(sanitizeTelegramUrl(sig.socials?.telegram) || (sig.source === 'TELEGRAM' && /^@?[A-Za-z0-9_]{4,32}$/.test(sig.authorHandle))) && (
                              <a
                                href={
                                  sanitizeTelegramUrl(sig.socials?.telegram) ||
                                  `https://t.me/${sig.authorHandle.replace('@', '')}`
                                }
                                target="_blank"
                                rel="noreferrer"
                                className="px-2 py-0.5 rounded bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[10px] font-mono flex items-center space-x-1 transition"
                                title={
                                  sanitizeTelegramUrl(sig.socials?.telegram)
                                    ? `Telegram link (creator-supplied, unverified): ${sanitizeTelegramUrl(sig.socials?.telegram)}`
                                    : `Open Channel on Telegram`
                                }
                              >
                                <Send className="w-2.5 h-2.5 text-blue-400" />
                                <span>Telegram</span>
                                <ExternalLink className="w-2 h-2 text-blue-400" />
                              </a>
                            )}

                            {/* Live Ingestion Indicator */}
                            {signalFeedBadge(sig) === 'LIVE' && (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center space-x-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                <span>LIVE</span>
                              </span>
                            )}
                            {signalFeedBadge(sig) === 'SYNTHETIC' && (
                              <span data-testid="synthetic-badge" className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">SYNTHETIC</span>
                            )}
                          </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center space-x-2">
                          {sig.status === 'SNIPED' ? (
                            <span className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs font-bold flex items-center space-x-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>SNIPED</span>
                            </span>
                          ) : (
                            <button
                              onClick={() => handleSnipeSignal(sig)}
                              disabled={snipeBlocked !== null}
                              title={snipeBlocked ?? undefined}
                              className="disabled:opacity-40 disabled:cursor-not-allowed px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs shadow-md shadow-emerald-950/40 flex items-center space-x-1.5 transition active:scale-95"
                            >
                              <Zap className="w-3.5 h-3.5" />
                              <span>Snipe {snipeAmount.parsed.ok ? formatSol(snipeAmount.parsed.sol) : '(set amount)'} ({tradingMode.label})</span>
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
                              <span className="text-slate-500 font-bold" title="Trending rank from the feed; — when it gives none">{fmtRank(pool.trendingRank)}</span>
                              <div>
                                <div className="font-bold text-white text-sm flex items-center space-x-1">
                                  <span>{dollarSymbol(pool.symbol)}</span>
                                  <span className="text-slate-400 text-xs font-normal truncate max-w-[220px]">({displayName(pool.name)})</span>
                                </div>
                                <div className="text-[10px] text-slate-400 flex items-center space-x-1">
                                  <span data-testid="pool-mint" title={pool.contractAddress} className="font-mono text-slate-300">{pool.contractAddress.slice(0, 8)}...{pool.contractAddress.slice(-6)}</span>
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
                                  symbol={displaySymbol(pool.symbol)}
                                  name={displayName(pool.name)}
                                  chain={pool.chain}
                                  platform={pool.platform}
                                  mainnetToken={pool.id.startsWith('pool-callout-')}
                                  compact={true}
                                  onOpenModal={() =>
                                    setSelectedExternalToken({
                                      mainnetToken: pool.id.startsWith('pool-callout-'),
                                      mintOrCa: pool.contractAddress,
                                      symbol: displaySymbol(pool.symbol),
                                      name: displayName(pool.name),
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
                              {fmtUsdPrice(pool.priceUsd)}
                            </div>
                            <div className={`text-[11px] font-bold flex items-center space-x-0.5 ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                              <span>{formatPctChange(pool.priceChange5mPct)} (5m)</span>
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
                                <span title="Share of the tokens off the bonding curve held by the 10 largest holders (not share of total supply)">Top 10 (off-curve):</span> <strong className="text-slate-200">{holderPct(pool.top10HoldersPct)}</strong>
                              </div>
                            </div>
                          </td>

                          {/* Action */}
                          <td className="p-3 text-right">
                            <button
                              onClick={() => {
                                handleSnipePool(pool);
                              }}
                              disabled={snipeBlocked !== null}
                              title={snipeBlocked ?? undefined}
                              className="disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow transition active:scale-95 flex items-center space-x-1 ml-auto"
                            >
                              <Zap className="w-3 h-3" />
                              <span>Snipe {snipeAmount.parsed.ok ? formatSol(snipeAmount.parsed.sol) : '(set amount)'}</span>
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
                <SniperAutoHeader autoMode={autoStatus?.mode ?? null} halted={!!autoStatus?.haltReason} />

                {/* Configuration Inputs */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                  {/* 3H (A2): a "Snipe Amount (USD)" box was here. It edited local state only and nothing sent it; every buy on this screen
                      takes its size from the shared snipe amount control (S181). */}
                  <div>
                    <label className="block text-slate-400 text-[10px] mb-1" data-testid="jito-tip-label">
                      {jitoUseText(jitoStatus).tipLabel}
                    </label>
                    <DecimalBox testId="sniper-jito-tip" ariaLabel="Jito tip (SOL)" value={sniperConfig.jitoTipSol} onValue={(n) => setSniperConfig({ ...sniperConfig, jitoTipSol: n })}
                      className="w-full bg-[#141B2D] border border-[#1E293B] rounded p-2 text-white font-mono outline-none focus:border-cyan-400"
                    />
                  </div>

                  {/* UI report fix 4: a take-profit percentage box was here. Its value was read only by the box itself: this screen never
                      posts the config, and the exits use the fixed ExitEngine rules (shown by ExitRulesNote), so it was removed. The Jito tip
                      box stays: its value is sent with every snipe from this screen. */}
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

                <div>
                  <SnipeAmountControl compact />
                </div>

                <button
                  onClick={handleManualSnipe}
                  disabled={manualSnipeLoading || !manualSnipeCa || snipeBlocked !== null}
                  title={snipeBlocked ?? undefined}
                  className="px-5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black font-bold text-xs font-mono flex items-center space-x-1.5 transition active:scale-95"
                >
                  <Zap className="w-4 h-4" />
                  <span>{manualSnipeLoading ? 'Sniping...' : 'Instant Snipe'}</span>
                </button>
              </div>

              {/* ACTIVE POSITIONS TABLE */}
              {(() => {
                // R9-13: this card holds open positions only. Closed rows were counted as "N Open" and kept live Take/Dump buttons.
                const openPositions = positions.filter((pos) => pos.status === 'OPEN');
                const filteredPositions = openPositions.filter((pos) => {
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
                          {openPositions.length} Open
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
                        <ExitRulesNote rules={exitRules} />
                      </div>
                    </div>

                    {openPositions.length === 0 ? (
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
                                        <span className="text-white text-sm font-bold tracking-wide">{dollarSymbol(pos.tokenTicker)}</span>
                                        {pos.tokenName && (
                                          <span className="text-slate-400 text-xs font-normal truncate max-w-[220px]">({displayName(pos.tokenName)})</span>
                                        )}
                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-800/80 text-cyan-300 border border-slate-700">
                                          {pos.chain}
                                        </span>
                                        {pos.executionMode && (
                                          <span
                                            data-testid="position-mode"
                                            title={pos.executionMode === 'LIVE' ? 'Real SOL position. Its exits keep running while the server is disarmed.' : 'Simulated position: no SOL moves.'}
                                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${pos.executionMode === 'LIVE' ? 'bg-rose-950/80 text-rose-300 border-rose-500/50' : 'bg-slate-800/80 text-slate-300 border-slate-700'}`}
                                          >
                                            {pos.executionMode === 'LIVE' ? 'LIVE (real SOL)' : pos.executionMode}
                                          </span>
                                        )}
                                      </div>

                                      {pos.contractAddress && (
                                        <span className="text-[10px] text-slate-500 font-normal font-mono truncate max-w-[210px] block">
                                          {pos.contractAddress}
                                        </span>
                                      )}

                                      {/* External Website Direct Launchers (DexScreener, Pump.fun, Birdeye, Solscan, Photon) */}
                                      <TokenInlineExternalLinks
                                        mintOrCa={pos.contractAddress}
                                        symbol={displaySymbol(pos.tokenTicker)}
                                        name={displayName(pos.tokenName)}
                                        chain={pos.chain}
                                        platform={pos.platform}
                                        onOpenModal={() =>
                                          setSelectedExternalToken({
                                            mintOrCa: pos.contractAddress,
                                            symbol: displaySymbol(pos.tokenTicker),
                                            name: displayName(pos.tokenName),
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
                                  <td className="p-3 text-slate-300">{fmtUsdPrice(pos.entryPriceUsd)}</td>
                                  <td className="p-3 font-bold text-cyan-300">{fmtUsdPrice(pos.currentPriceUsd)}</td>
                                  <td className="p-3 text-slate-200">
                                    ${(pos.currentValueUsd ?? 0).toFixed(2)}{' '}
                                    <span className="text-slate-500 text-[10px]">(${(pos.costBasisUsd ?? 0).toFixed(2)} cost)</span>
                                    <span className="block text-slate-500 text-[10px]" data-testid="holding-qty">{fmtSmall(pos.quantityTokens, 0)} tokens held</span>
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
                    <span className="font-bold text-white">Local command console (not connected to Telegram)</span>
                  </div>
                  {/* UI report fix 3: nothing polls Telegram (getUpdates and setWebhook are not implemented), so the badge says that */}
                  <span data-testid="telegram-status-badge" title="Commands typed here run on this server only. Telegram messages are never fetched, so /panic_sell from a phone does nothing; use the PANIC button here." className="text-[10px] text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30">
                    STATUS: NOT POLLING TELEGRAM (local console)
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
                    A bot token lets you test the connection and send one ping. Nothing is sent to Telegram automatically: alert forwarding is not built, and commands run only when something posts to /api/telegram/webhook.
                  </p>

                  <div>
                    <label className="block text-slate-400 text-[10px] mb-1">Bot Token</label>
                    <input
                      type="password"
                      placeholder="Enter Bot Token from @BotFather..."
                      value={telegramDraft.botToken}
                      onChange={(e) => setTelegramDraft((d) => ({ ...d, botToken: e.target.value }))}
                      className="w-full bg-[#141B2D] border border-[#1E293B] rounded p-2 text-slate-300 text-xs font-mono outline-none focus:border-cyan-500/50"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 text-[10px] mb-1">Alert Channel / Chat ID</label>
                    <input
                      type="text"
                      placeholder="e.g. @apex_alpha_vip_snipers or chat ID"
                      value={telegramDraft.chatId}
                      onChange={(e) => setTelegramDraft((d) => ({ ...d, chatId: e.target.value }))}
                      className="w-full bg-[#141B2D] border border-[#1E293B] rounded p-2 text-slate-300 text-xs font-mono outline-none focus:border-cyan-500/50"
                    />
                  </div>

                  <div className="flex items-center space-x-2 pt-1">
                    <button
                      onClick={async () => {
                        const res = await engineClient.updateTelegramConfig({
                          botToken: telegramDraft.botToken,
                          chatId: telegramDraft.chatId,
                        });
                        const out = telegramSaveOutcome(res);
                        onAlertTrigger?.(out.level, out.title, out.message);
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
                    <li><strong className="text-cyan-300">/panic_sell</strong> - Dump all memecoins (not delivered from Telegram: no webhook is registered and nothing polls; use the panic button here)</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* COMPREHENSIVE OUTSIDE WORLD CONNECTIVITY & SIMULATION AUDIT MODAL */}
      {showDiagnosticsModal && diagnosticsResult && (
        <DialogFrame label="Connectivity audit" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6">
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
                      AUDIT
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
                      {(() => { const b = probeBadge(diagnosticsResult.connections.telegram.testResult, 'REACHABLE'); return (<span className={`px-2 py-0.5 rounded text-[10px] ${probeBadgeClass(b)}`}>{b.text}</span>); })()}
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">https://api.telegram.org</code>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{probeLatency(diagnosticsResult.connections.telegram.testResult.latencyMs)}</strong> | Auth: {diagnosticsResult.connections.telegram.testResult.botAuthorized ? 'VALIDATED' : diagnosticsResult.connections.telegram.testResult.reachable ? 'NOT AUTHORIZED' : 'not checked'}
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
                      {(() => { const b = probeBadge(diagnosticsResult.connections.xTwitter?.testResult, 'REACHABLE'); return (<span className={`px-2 py-0.5 rounded text-[10px] ${probeBadgeClass(b)}`}>{b.text}</span>); })()}
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">https://api.twitter.com</code>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{probeLatency(diagnosticsResult.connections.xTwitter?.testResult?.latencyMs)}</strong> | Mode: {diagnosticsResult.connections.xTwitter?.testResult?.bearerAuthorized ? 'AUTHENTICATED' : 'NO BEARER TOKEN (public metadata only)'}
                    </div>
                    <p className="text-slate-400 text-[10px] border-t border-slate-800 pt-1">
                      {diagnosticsResult.connections.xTwitter?.testResult?.diagnosis || 'The probe returned no detail.'}
                    </p>
                  </div>

                  {/* Pump.fun */}
                  <div className="p-3 rounded-xl bg-[#101728] border border-[#1E293B] space-y-1.5">
                    <div className="flex items-center justify-between font-bold">
                      <span className="text-white flex items-center space-x-1.5">
                        <Flame className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Pump.fun Live Coin Stream</span>
                      </span>
                      {(() => { const b = probeBadge(diagnosticsResult.connections.pumpFun.testResult, 'REACHABLE'); return (<span className={`px-2 py-0.5 rounded text-[10px] ${probeBadgeClass(b)}`}>{b.text}</span>); })()}
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">frontend-api-v3.pump.fun/coins</code>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{probeLatency(diagnosticsResult.connections.pumpFun.testResult.latencyMs)}</strong> | Newest: {diagnosticsResult.connections.pumpFun.testResult.newestToken || '—'}
                    </div>
                    <p className="text-slate-400 text-[10px] border-t border-slate-800 pt-1">
                      {diagnosticsResult.connections.pumpFun.testResult.diagnosis ||
                        'A probe of the pump.fun HTTP API. The app polls it only on mainnet-beta; on other clusters the board fills from the on-chain log stream.'}
                    </p>
                  </div>

                  {/* DexScreener */}
                  <div className="p-3 rounded-xl bg-[#101728] border border-[#1E293B] space-y-1.5">
                    <div className="flex items-center justify-between font-bold">
                      <span className="text-white flex items-center space-x-1.5">
                        <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
                        <span>DexScreener Boosted Feed</span>
                      </span>
                      {(() => { const b = probeBadge(diagnosticsResult.connections.dexScreener.testResult, 'REACHABLE'); return (<span className={`px-2 py-0.5 rounded text-[10px] ${probeBadgeClass(b)}`}>{b.text}</span>); })()}
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">api.dexscreener.com/token-boosts</code>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{probeLatency(diagnosticsResult.connections.dexScreener.testResult.latencyMs)}</strong> | Boosted list: {diagnosticsResult.connections.dexScreener.testResult.boostedCount ?? '—'} tokens
                    </div>
                    <p className="text-slate-400 text-[10px] border-t border-slate-800 pt-1">
                      {diagnosticsResult.connections.dexScreener.testResult.diagnosis ||
                        'A probe of the DexScreener paid-boost list. It is mainnet data, so the confluence trigger can only use it on mainnet-beta.'}
                    </p>
                  </div>

                  {/* Solana Cluster */}
                  <div className="p-3 rounded-xl bg-[#101728] border border-[#1E293B] space-y-1.5">
                    <div className="flex items-center justify-between font-bold">
                      <span className="text-white flex items-center space-x-1.5">
                        <Server className="w-3.5 h-3.5 text-purple-400" />
                        <span>Solana Validator JSON-RPC</span>
                      </span>
                      {(() => { const b = probeBadge(diagnosticsResult.connections.solanaRpc.testResult, 'RPC REACHABLE'); return (<span className={`px-2 py-0.5 rounded text-[10px] ${probeBadgeClass(b)}`}>{b.text}</span>); })()}
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Endpoint: <code className="text-slate-300">{hostOfService(diagnosticsResult.connections.solanaRpc.service)}</code>{diagnosticsResult.cluster ? <span className="ml-2 text-amber-300">cluster: {diagnosticsResult.cluster}</span> : null}
                    </div>
                    <div className="text-[11px] text-slate-300">
                      Latency: <strong className="text-cyan-400">{probeLatency(diagnosticsResult.connections.solanaRpc.testResult.latencyMs)}</strong> | Cluster Slot: {diagnosticsResult.connections.solanaRpc.testResult.slot != null ? `#${diagnosticsResult.connections.solanaRpc.testResult.slot}` : '—'}
                    </div>
                    <p className="text-slate-400 text-[10px] border-t border-slate-800 pt-1">
                      getHealth and getSlot on the configured cluster RPC.
                    </p>
                  </div>
                </div>
              </div>

              {/* SECTION 2: MARKET MAKER & CALLER PERSONAS */}
              <div>
                <h4 className="font-bold text-slate-200 uppercase tracking-wider text-[11px] mb-2 flex items-center space-x-1.5">
                  <Crosshair className="w-3.5 h-3.5 text-amber-400" />
                  <span>Caller Profiles</span>
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
        </DialogFrame>
      )}

      {/* External Token Explorer & Web Platform Modal */}
      <TokenExternalLinksModal
        isOpen={Boolean(selectedExternalToken)}
        onClose={() => setSelectedExternalToken(null)}
        tokenData={selectedExternalToken}
      />
    </DialogFrame>
  );
};
