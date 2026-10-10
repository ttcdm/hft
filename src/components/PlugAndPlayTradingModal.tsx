import React, { useState, useEffect } from 'react';
import {
  Wallet,
  Play,
  Square,
  AlertTriangle,
  Zap,
  Shield,
  RefreshCw,
  TrendingUp,
  X,
  Radio,
  Sliders,
  DollarSign,
  Lock,
  Target,
  Search,
  ArrowLeft,
  Key,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import { TokenInlineExternalLinks, TokenExternalLinksModal } from './TokenExternalLinksView';
import { authFetch } from '../services/engineClient';

interface PlugAndPlayTradingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SystemAudit {
  mode: 'PAPER' | 'LIVE';
  isLiveArmed: boolean;
  killSwitchActive: boolean;
  walletSolBalance: number | null;
  walletPubkey: string;
  signerStatus: 'READY' | 'LOCKED' | 'NOT_CONFIGURED';
  rpcEndpoint: string;
  rpcLatencyMs: number;
  databaseFile: string;
  dbDriver: string;
  keypairStorage: string;
  browserPrivateKeySecurity: string;
  hftPaperIsolation: string;
}

interface RiskControls {
  tier: string;
  maxPositionSol: number;
  maxDailyLossSol: number;
  maxAggregateExposureSol: number;
  dailyLossSoFarSol: number;
  circuitBreakerTripped: boolean;
}

export const PlugAndPlayTradingModal: React.FC<PlugAndPlayTradingModalProps> = ({ isOpen, onClose }) => {
  const [systemAudit, setSystemAudit] = useState<SystemAudit | null>(null);
  const [riskControls, setRiskControls] = useState<RiskControls | null>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'POSITIONS' | 'RISK_LOGS' | 'SETUP'>('OVERVIEW');

  // Arming modal state
  const [showArmConfirmModal, setShowArmConfirmModal] = useState(false);
  const [confirmationCodeInput, setConfirmationCodeInput] = useState('');

  // Settings
  const [capitalTier, setCapitalTier] = useState<'MICRO_10' | 'INSTITUTIONAL'>('MICRO_10');
  const [allocatedSol, setAllocatedSol] = useState(0.07);
  const [jitoTipSol, setJitoTipSol] = useState(0.002);
  const [slippageBps, setSlippageBps] = useState(600);

  // Manual Snipe Input
  const [manualMint, setManualMint] = useState('');
  const [manualAmountSol, setManualAmountSol] = useState(0.015);
  const [positionSearchQuery, setPositionSearchQuery] = useState('');
  const [selectedExternalToken, setSelectedExternalToken] = useState<any>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'info' | 'success' | 'error' } | null>(null);

  const fetchSystemData = async () => {
    try {
      const [diagRes, posRes, evRes] = await Promise.all([
        authFetch('/api/diagnostics/system'),
        authFetch('/api/workstation/positions'),
        authFetch('/api/workstation/events?limit=25'),
      ]);

      if (diagRes.ok) {
        const dJson = await diagRes.json();
        setSystemAudit(dJson.systemAudit);
        setRiskControls(dJson.riskControls);
      }

      if (posRes.ok) {
        const pJson = await posRes.json();
        setPositions(pJson.positions || []);
      }

      if (evRes.ok) {
        const eJson = await evRes.json();
        setEvents(eJson.events || []);
      }
    } catch (err) {
      console.error('Failed to fetch system data:', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchSystemData();
      const timer = setInterval(fetchSystemData, 3000);
      return () => clearInterval(timer);
    }
  }, [isOpen]);

  const handleGenerateKeypair = async (forceOverwrite = false) => {
    try {
      setIsLoading(true);
      const res = await authFetch('/api/signer/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceOverwrite }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate keypair');
      setStatusMessage({ text: data.message, type: 'success' });
      await fetchSystemData();
    } catch (err: any) {
      setStatusMessage({ text: err.message, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleArmLiveTrading = async () => {
    try {
      setIsLoading(true);
      const res = await authFetch('/api/execution/arm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          arm: true,
          confirmationCode: confirmationCodeInput.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to arm live trading');

      setStatusMessage({
        text: 'LIVE TRADING ARMED: On-chain transactions will now execute via Jito MEV bundles with real SOL.',
        type: 'success',
      });
      setShowArmConfirmModal(false);
      setConfirmationCodeInput('');
      await fetchSystemData();
    } catch (err: any) {
      setStatusMessage({ text: err.message, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisarmLiveTrading = async () => {
    try {
      setIsLoading(true);
      const res = await authFetch('/api/execution/arm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arm: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        setStatusMessage({ text: data.message || data.error || `Disarm failed (HTTP ${res.status}). Live trading may still be armed.`, type: 'error' });
        return;
      }
      setStatusMessage({ text: 'Trading disarmed. Defaulting safely to paper simulation mode.', type: 'info' });
      await fetchSystemData();
    } catch (err: any) {
      setStatusMessage({ text: err.message, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmergencyKillSwitch = async (activate: boolean) => {
    try {
      setIsLoading(true);
      const res = await authFetch('/api/execution/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activate }),
      });
      const data = await res.json();
      setStatusMessage({ text: data.message, type: activate ? 'error' : 'info' });
      await fetchSystemData();
    } catch (err: any) {
      setStatusMessage({ text: err.message, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleManualSnipe = async () => {
    if (!manualMint || manualMint.length < 32) {
      setStatusMessage({ text: 'Please enter a valid Solana token mint address', type: 'error' });
      return;
    }

    try {
      setIsLoading(true);
      const res = await authFetch('/api/wallet/snipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mint: manualMint.trim(),
          amountSol: Number(manualAmountSol),
          slippagePct: Number(slippageBps) / 100,
          jitoTipSol: Number(jitoTipSol),
          callerHandle: '@manual_terminal',
          confluenceScore: 100,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Snipe order failed');

      setStatusMessage({
        text: `Snipe executed successfully! ID: ${data.data?.positionId} (TX: ${data.data?.txSignature?.slice(0, 16)}...)`,
        type: 'success',
      });
      setManualMint('');
      await fetchSystemData();
    } catch (err: any) {
      setStatusMessage({ text: err.message || 'Snipe failed', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleClosePosition = async (posId: string) => {
    try {
      const res = await authFetch('/api/wallet/close-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId: posId, sellPct: 100 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Close position failed');
      await fetchSystemData();
      setStatusMessage({ text: `Position closed with PnL: ${data.data?.realizedPnLSol} SOL`, type: 'info' });
    } catch (err: any) {
      setStatusMessage({ text: err.message || 'Failed to close position', type: 'error' });
    }
  };

  const handlePanicLiquidate = async () => {
    if (!confirm('EMERGENCY: Are you sure you want to close ALL open positions immediately and trip the circuit breaker?')) return;
    try {
      setIsLoading(true);
      const res = await authFetch('/api/wallet/panic-liquidate', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatusMessage({ text: data.message || data.error || `Panic liquidate failed (HTTP ${res.status}). Positions may still be open.`, type: 'error' });
        return;
      }
      setStatusMessage({ text: data.message || 'Panic liquidate sent.', type: 'error' });
      await fetchSystemData();
    } catch (err: any) {
      setStatusMessage({ text: err.message || 'Panic liquidate failed', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed top-16 inset-x-0 bottom-0 z-40 flex items-start justify-center bg-black/85 backdrop-blur-md p-2 sm:p-4 overflow-y-auto font-sans">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-5xl shadow-2xl overflow-hidden my-2 sm:my-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/90 gap-3">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center flex-shrink-0">
              <Zap className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-base sm:text-lg font-bold text-white tracking-wide">SOLANA TRADING WORKSTATION</h2>
                <span
                  className={`px-2 py-0.5 text-xs font-bold rounded ${
                    systemAudit?.isLiveArmed
                      ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40 animate-pulse'
                      : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  }`}
                >
                  {systemAudit?.isLiveArmed ? 'LIVE BROADCAST ACTIVE' : 'PAPER TRADING (SAFE)'}
                </span>
                <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-slate-800 text-slate-300 border border-slate-700">
                  MICRO $10 TIER
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Pump.fun & Raydium sniper engine with isolated risk enforcement and deterministic SQLite persistence
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2 flex-shrink-0">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition border border-slate-700 flex items-center space-x-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Live Status Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 p-3.5 bg-slate-950 border-b border-slate-800/80 text-xs">
          <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider mb-0.5">Execution Mode</span>
            <div className="flex items-center space-x-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  systemAudit?.isLiveArmed ? 'bg-rose-400 animate-ping' : 'bg-emerald-400'
                }`}
              />
              <span className={`font-bold ${systemAudit?.isLiveArmed ? 'text-rose-400' : 'text-emerald-400'}`}>
                {systemAudit?.mode || 'PAPER'}
              </span>
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider mb-0.5">Wallet Balance</span>
            <span className="text-white font-bold text-sm">
              {systemAudit?.walletSolBalance != null ? `${systemAudit.walletSolBalance} SOL` : 'Unconfirmed'}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider mb-0.5">Signer Status</span>
            <span
              className={`font-bold text-xs flex items-center ${
                systemAudit?.signerStatus === 'READY' ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              <Key className="w-3 h-3 mr-1" />
              {systemAudit?.signerStatus || 'NOT_CONFIGURED'}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider mb-0.5">Circuit Breaker</span>
            <span
              className={`font-bold text-xs ${
                riskControls?.circuitBreakerTripped ? 'text-rose-400' : 'text-emerald-400'
              }`}
            >
              {riskControls?.circuitBreakerTripped ? 'TRIPPED (HALTED)' : 'NORMAL (ACTIVE)'}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 flex items-center justify-between">
            <div>
              <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider mb-0.5">RPC Latency</span>
              <span className="text-cyan-400 font-bold text-sm flex items-center">
                <Radio className="w-3.5 h-3.5 mr-1" />
                {systemAudit?.rpcLatencyMs != null ? `${systemAudit.rpcLatencyMs} ms` : 'n/a'}
              </span>
            </div>
            <button
              onClick={fetchSystemData}
              title="Refresh State"
              className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-800 bg-slate-950/60 px-4 text-xs font-semibold">
          <button
            onClick={() => setActiveTab('OVERVIEW')}
            className={`px-4 py-2.5 border-b-2 transition ${
              activeTab === 'OVERVIEW'
                ? 'border-amber-400 text-white font-bold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Overview & Execution
          </button>
          <button
            onClick={() => setActiveTab('POSITIONS')}
            className={`px-4 py-2.5 border-b-2 transition ${
              activeTab === 'POSITIONS'
                ? 'border-amber-400 text-white font-bold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Open Positions ({positions.filter((p) => p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED').length})
          </button>
          <button
            onClick={() => setActiveTab('RISK_LOGS')}
            className={`px-4 py-2.5 border-b-2 transition ${
              activeTab === 'RISK_LOGS'
                ? 'border-amber-400 text-white font-bold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Audit Trail & Event Log
          </button>
          <button
            onClick={() => setActiveTab('SETUP')}
            className={`px-4 py-2.5 border-b-2 transition ${
              activeTab === 'SETUP'
                ? 'border-amber-400 text-white font-bold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Signer & Security Setup
          </button>
        </div>

        {/* Notification Toast */}
        {statusMessage && (
          <div
            className={`mx-6 mt-4 p-3 rounded-xl border text-xs flex items-center justify-between ${
              statusMessage.type === 'success'
                ? 'bg-emerald-950/60 border-emerald-600/40 text-emerald-300'
                : statusMessage.type === 'error'
                ? 'bg-rose-950/60 border-rose-600/40 text-rose-300'
                : 'bg-blue-950/60 border-blue-600/40 text-blue-300'
            }`}
          >
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{statusMessage.text}</span>
            </div>
            <button onClick={() => setStatusMessage(null)}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Body Content */}
        <div className="p-5 space-y-5 max-h-[62vh] overflow-y-auto text-xs">
          {activeTab === 'OVERVIEW' && (
            <>
              {/* Architecture Reality Card */}
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <h3 className="font-bold text-slate-200 flex items-center space-x-2 text-xs uppercase tracking-wider">
                  <Shield className="w-4 h-4 text-emerald-400" />
                  <span>Verified Architecture Guarantees</span>
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-slate-300 text-[11px] leading-relaxed">
                  <div className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-1">
                    <strong className="text-white block">1. Micro-Capital $10 Envelope:</strong>
                    Max trade size is capped strictly at 0.02 SOL (~$2.90 USD). Max aggregate exposure is capped at 0.06 SOL (~$8.70 USD) to ensure rent exemption and transaction fees are preserved.
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-1">
                    <strong className="text-white block">2. Signer Isolation & Security:</strong>
                    Private keys are stored in a local JSON keypair file with mode 0600 on the workstation. Browser requests NEVER accept private keys over HTTP or WebSockets.
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-1">
                    <strong className="text-white block">3. Isolated Paper Engine:</strong>
                    The BTC/ETH engine console is a simulation and does not touch the Solana wallet. Paper snipes are modeled fills against the curve quote.
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-1">
                    <strong className="text-white block">4. Deterministic SQLite Storage:</strong>
                    All state is saved locally in SQLite (`apex_workstation.db`) with WAL mode enabled. No hardcoded or fake random PnL data.
                  </div>
                </div>
              </div>

              {/* Manual Snipe Terminal */}
              <div className="bg-slate-950/70 p-4 rounded-xl border border-slate-800 space-y-3">
                <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center justify-between">
                  <span className="flex items-center space-x-1.5">
                    <Target className="w-4 h-4 text-rose-400" />
                    <span>Instant Token Snipe Terminal</span>
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    Mode: <strong className={systemAudit?.isLiveArmed ? 'text-rose-400' : 'text-emerald-400'}>{systemAudit?.mode}</strong>
                  </span>
                </h3>

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={manualMint}
                    onChange={(e) => setManualMint(e.target.value)}
                    placeholder="Enter Pump.fun / Raydium token mint address..."
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono focus:border-amber-500 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <input
                      type="number"
                      step="0.005"
                      max={riskControls?.maxPositionSol || 0.02}
                      value={manualAmountSol}
                      onChange={(e) => setManualAmountSol(parseFloat(e.target.value) || 0.01)}
                      className="w-24 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-white font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleManualSnipe}
                      disabled={isLoading || !manualMint}
                      className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold flex items-center space-x-1.5 transition"
                    >
                      <Zap className="w-3.5 h-3.5" />
                      <span>{systemAudit?.isLiveArmed ? 'LIVE SNIPE' : 'PAPER SNIPE'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'POSITIONS' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-white text-xs">Positions Blotter</span>
                <input
                  type="text"
                  placeholder="Filter by symbol or mint..."
                  value={positionSearchQuery}
                  onChange={(e) => setPositionSearchQuery(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1 text-xs text-white font-mono"
                />
              </div>

              {positions.length === 0 ? (
                <div className="p-8 text-center text-slate-400 bg-slate-950/40 rounded-xl border border-slate-800">
                  No positions opened yet. Snipe a token to record honest execution in SQLite.
                </div>
              ) : (
                <div className="overflow-x-auto border border-slate-800 rounded-xl">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950 text-slate-400 font-semibold border-b border-slate-800">
                      <tr>
                        <th className="p-2.5">Token</th>
                        <th className="p-2.5">Mode</th>
                        <th className="p-2.5">Cost Basis</th>
                        <th className="p-2.5">Current Value</th>
                        <th className="p-2.5">PnL</th>
                        <th className="p-2.5">Status</th>
                        <th className="p-2.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-900/40">
                      {positions
                        .filter((p) => !positionSearchQuery || (p.symbol ?? '').toLowerCase().includes(positionSearchQuery.toLowerCase()))
                        .map((pos) => (
                          <tr key={pos.id}>
                            <td className="p-2.5 font-mono">
                              <div className="font-bold text-white">${pos.symbol || pos.mint.slice(0, 6)}</div>
                              <span className="text-[10px] text-slate-400 truncate block max-w-[140px]">{pos.mint}</span>
                            </td>
                            <td className="p-2.5">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  pos.executionMode === 'LIVE' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
                                }`}
                              >
                                {pos.executionMode}
                              </span>
                            </td>
                            <td className="p-2.5 font-mono">{((pos.costBasisLamports ?? 0) / 1e9).toFixed(4)} SOL</td>
                            <td className="p-2.5 font-mono">{(pos.currentValueSol ?? 0).toFixed(4)} SOL</td>
                            <td className="p-2.5 font-mono font-bold">
                              <span className={(pos.unrealizedPnLPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                {(pos.unrealizedPnLPct ?? 0) >= 0 ? '+' : ''}
                                {(pos.unrealizedPnLPct ?? 0).toFixed(1)}%
                              </span>
                            </td>
                            <td className="p-2.5">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  pos.status === 'OPEN' ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700 text-slate-300'
                                }`}
                              >
                                {pos.status}
                              </span>
                            </td>
                            <td className="p-2.5 text-right">
                              {(pos.status === 'OPEN' || pos.status === 'PARTIALLY_CLOSED') && (
                                <button
                                  onClick={() => handleClosePosition(pos.id)}
                                  className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-rose-300 text-[11px] font-bold"
                                >
                                  Close
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === 'RISK_LOGS' && (
            <div className="space-y-3">
              <span className="font-bold text-white text-xs">Immutable Event Log (SQLite Journal)</span>
              {events.length === 0 ? (
                <div className="p-8 text-center text-slate-400 bg-slate-950/40 rounded-xl border border-slate-800">
                  No events logged yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {events.map((ev) => (
                    <div
                      key={ev.id}
                      className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between text-[11px]"
                    >
                      <div className="flex items-center space-x-2">
                        <span className="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono text-[10px]">
                          {ev.eventType}
                        </span>
                        <span className="text-white font-mono">{ev.payload?.mint || ev.payload?.positionId || ''}</span>
                        <span className="text-slate-400">{ev.payload?.reason || ev.payload?.source || ''}</span>
                      </div>
                      <span className="text-slate-500 text-[10px] font-mono">
                        {new Date(ev.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'SETUP' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                <h3 className="font-bold text-white text-xs uppercase tracking-wider flex items-center space-x-2">
                  <Key className="w-4 h-4 text-amber-400" />
                  <span>Local Hot Wallet Signer</span>
                </h3>
                <p className="text-slate-400 text-xs">
                  To execute live transactions without exposing private keys, Apex Workstation manages a local hot keypair stored in `.apex_trading_keypair.json` with strict POSIX 0600 file permissions.
                </p>

                <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 font-mono text-xs text-slate-300 space-y-1">
                  <div>Status: <strong className="text-emerald-400">{systemAudit?.signerStatus}</strong></div>
                  <div>Public Key: <span className="text-amber-300">{systemAudit?.walletPubkey || 'None'}</span></div>
                  <div>Storage Location: <span className="text-slate-400">.apex_trading_keypair.json (mode 0600)</span></div>
                </div>

                <div className="flex items-center space-x-3 pt-2">
                  <button
                    onClick={handleGenerateKeypair}
                    disabled={isLoading}
                    className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center space-x-1.5"
                  >
                    <Key className="w-3.5 h-3.5" />
                    <span>Generate Local Signer Keypair</span>
                  </button>
                  <span className="text-[11px] text-slate-400">
                    Fund this address with 0.07 SOL to begin live trading.
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Controls */}
        <div className="p-4 border-t border-slate-800 bg-slate-950 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center space-x-2 text-xs text-slate-400">
            <Shield className="w-4 h-4 text-emerald-400" />
            <span>Risk-governed execution. Jito bundles are used on mainnet-beta only; devnet and localnet send plain transactions.</span>
          </div>

          <div className="flex items-center space-x-2.5 w-full sm:w-auto">
            {/* Panic Liquidate / Trip Circuit Breaker */}
            <button
              onClick={handlePanicLiquidate}
              className="px-3.5 py-2 rounded-lg bg-rose-950/60 hover:bg-rose-900/80 border border-rose-600/50 text-rose-300 font-bold text-xs flex items-center space-x-1.5"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>PANIC LIQUIDATE</span>
            </button>

            {/* Arm / Disarm Live Mode */}
            {systemAudit?.isLiveArmed ? (
              <button
                onClick={handleDisarmLiveTrading}
                className="px-5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs flex items-center space-x-1.5"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>DISARM LIVE TRADING</span>
              </button>
            ) : (
              <button
                onClick={() => setShowArmConfirmModal(true)}
                className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center space-x-1.5"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>ARM LIVE TRADING</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation Modal to Arm Live Trading */}
      {showArmConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4">
          <div className="bg-slate-900 border border-rose-500/60 rounded-2xl p-5 max-w-md w-full space-y-4 shadow-2xl">
            <div className="flex items-center space-x-2.5 text-rose-400 font-bold text-sm">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <span>CONFIRM LIVE SOLANA BROADCAST</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              You are about to arm real-money live trading on the Solana mainnet. Any snipes will consume real SOL from your funded hot wallet via Jito MEV bundles.
            </p>
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] space-y-1 font-mono text-slate-400">
              <div>• Tier: MICRO_10 (0.02 SOL max order size)</div>
              <div>• Daily Drawdown Cap: 20% (~$2.50 USD)</div>
              <div>• Jito Priority Tip: {jitoTipSol} SOL</div>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-400 mb-1">
                Type <code className="text-rose-300">CONFIRM_LIVE_TRADING_RISK</code> to proceed:
              </label>
              <input
                type="text"
                value={confirmationCodeInput}
                onChange={(e) => setConfirmationCodeInput(e.target.value)}
                placeholder="CONFIRM_LIVE_TRADING_RISK"
                className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-xs text-white font-mono focus:border-rose-500 focus:outline-none"
              />
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => {
                  setShowArmConfirmModal(false);
                  setConfirmationCodeInput('');
                }}
                className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleArmLiveTrading}
                disabled={confirmationCodeInput !== 'CONFIRM_LIVE_TRADING_RISK'}
                className="px-4 py-1.5 rounded bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-bold"
              >
                Confirm & Arm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
