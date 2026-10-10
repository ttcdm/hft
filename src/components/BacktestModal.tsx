import React, { useState, useMemo, useRef, useEffect } from 'react';
import { SyntheticBanner } from './SyntheticBanner';
import {
  X,
  Play,
  RotateCw,
  TrendingUp,
  BarChart3,
  Calendar,
  Layers,
  ShieldCheck,
  Zap,
  DollarSign,
  Award,
  Users,
  Radio,
  FileDown,
  ArrowUpRight,
  ArrowDownRight,
  Filter,
  CheckCircle2,
} from 'lucide-react';
import {
  run60DayBacktest,
  BacktestResult,
  BacktestConfig,
  CALLER_METADATA,
} from '../utils/backtestEngine';

interface BacktestModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentCapitalTier?: 'MICRO_10' | 'INSTITUTIONAL';
}

type ActiveTab = 'EQUITY_CURVE' | 'STRATEGY_BREAKDOWN' | 'CALLER_ALPHA' | 'DAILY_HEATMAP' | 'TRADE_BLOTTER';

export const BacktestModal: React.FC<BacktestModalProps> = ({
  isOpen,
  onClose,
  currentCapitalTier = 'MICRO_10',
}) => {
  const [capitalTier, setCapitalTier] = useState<'MICRO_10' | 'INSTITUTIONAL'>(currentCapitalTier);
  const [coLocation, setCoLocation] = useState<'TOKYO_TY2' | 'EQUINIX_NY4' | 'DUBLIN' | 'OREGON'>('TOKYO_TY2');
  const [enableMM, setEnableMM] = useState(true);
  const [enableArb, setEnableArb] = useState(true);
  const [enableMom, setEnableMom] = useState(true);
  const [enableStatArb, setEnableStatArb] = useState(true);
  const [enableSniper, setEnableSniper] = useState(true);
  const [jitoTipSol, setJitoTipSol] = useState(0.005);
  const [slippageBps, setSlippageBps] = useState(6.0);

  const [activeTab, setActiveTab] = useState<ActiveTab>('EQUITY_CURVE');
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [tradeSearch, setTradeSearch] = useState('');
  const [strategyFilter, setStrategyFilter] = useState('ALL');
  const [hoveredDayIndex, setHoveredDayIndex] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Run backtest function
  const executeBacktest = () => {
    setIsRunning(true);
    // Micro-delay to let UI show spinner
    setTimeout(() => {
      const res = run60DayBacktest({
        capitalTier,
        coLocationProfile: coLocation,
        enableMarketMaking: enableMM,
        enableCrossArb: enableArb,
        enableMomentum: enableMom,
        enableStatArb: enableStatArb,
        enablePumpSniper: enableSniper,
        jitoTipSol,
        slippageLimitBps: slippageBps,
      });
      setResult(res);
      setIsRunning(false);
    }, 150);
  };

  // Run automatically on first open if no result
  useEffect(() => {
    if (isOpen && !result) {
      executeBacktest();
    }
  }, [isOpen]);

  // Sync capital tier with external change
  useEffect(() => {
    if (currentCapitalTier) {
      setCapitalTier(currentCapitalTier);
    }
  }, [currentCapitalTier]);

  // Draw 60-Day Equity Curve Canvas
  useEffect(() => {
    if (!result || activeTab !== 'EQUITY_CURVE') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const records = result.dailyRecords;
    if (!records || records.length === 0) return;

    const equities = records.map((r) => r.cumulativeEquity);
    const minVal = Math.min(...equities, result.initialBalance) * 0.96;
    const maxVal = Math.max(...equities) * 1.04;
    const range = maxVal - minVal || 1;

    // Grid lines
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (let i = 1; i <= 4; i++) {
      const y = (height / 5) * i;
      ctx.beginPath();
      ctx.moveTo(40, y);
      ctx.lineTo(width - 15, y);
      ctx.stroke();

      const labelVal = maxVal - (range / 5) * i;
      ctx.fillStyle = '#64748B';
      ctx.font = '10px monospace';
      ctx.fillText(
        labelVal >= 1000 ? `$${(labelVal / 1000).toFixed(1)}k` : `$${labelVal.toFixed(1)}`,
        5,
        y + 3
      );
    }
    ctx.setLineDash([]);

    const padL = 45;
    const padR = 20;
    const padT = 15;
    const padB = 25;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;

    // Area Gradient Fill
    const gradient = ctx.createLinearGradient(0, padT, 0, height - padB);
    gradient.addColorStop(0, 'rgba(0, 230, 118, 0.35)');
    gradient.addColorStop(0.7, 'rgba(0, 229, 255, 0.12)');
    gradient.addColorStop(1, 'rgba(6, 8, 13, 0.0)');

    ctx.beginPath();
    ctx.moveTo(padL, height - padB);

    records.forEach((r, idx) => {
      const x = padL + (idx / (records.length - 1)) * chartW;
      const y = padT + (1 - (r.cumulativeEquity - minVal) / range) * chartH;
      if (idx === 0) ctx.lineTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.lineTo(padL + chartW, height - padB);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Main Equity Curve Stroke
    ctx.beginPath();
    records.forEach((r, idx) => {
      const x = padL + (idx / (records.length - 1)) * chartW;
      const y = padT + (1 - (r.cumulativeEquity - minVal) / range) * chartH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#00E676';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Baseline Initial Capital Line
    const initialY = padT + (1 - (result.initialBalance - minVal) / range) * chartH;
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
    ctx.lineWidth = 1;
    ctx.moveTo(padL, initialY);
    ctx.lineTo(padL + chartW, initialY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Hover indicator if day hovered
    if (hoveredDayIndex !== null && hoveredDayIndex >= 0 && hoveredDayIndex < records.length) {
      const hx = padL + (hoveredDayIndex / (records.length - 1)) * chartW;
      const hy = padT + (1 - (records[hoveredDayIndex].cumulativeEquity - minVal) / range) * chartH;

      ctx.strokeStyle = '#00E5FF';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, height - padB);
      ctx.stroke();

      ctx.fillStyle = '#00E5FF';
      ctx.beginPath();
      ctx.arc(hx, hy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [result, activeTab, hoveredDayIndex]);

  // Filtered trades
  const filteredTrades = useMemo(() => {
    if (!result?.recentTrades) return [];
    return result.recentTrades.filter((t) => {
      const matchesStrat = strategyFilter === 'ALL' || t.strategy === strategyFilter;
      const q = tradeSearch.toLowerCase().trim();
      const matchesSearch =
        !q ||
        t.symbol.toLowerCase().includes(q) ||
        t.strategy.toLowerCase().includes(q) ||
        (t.caller && t.caller.toLowerCase().includes(q));
      return matchesStrat && matchesSearch;
    });
  }, [result, strategyFilter, tradeSearch]);

  // Export backtest report to JSON
  const handleExportJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apex_60day_backtest_${result.config.capitalTier}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl max-w-6xl w-full shadow-2xl flex flex-col max-h-[94vh] overflow-hidden">
        {/* MODAL HEADER */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#1E293B] bg-[#0A0E17]">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <TrendingUp className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                  60-Day Simulated Backtest
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold">
                  Synthetic 60-day window
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                End-to-end multi-strategy simulation with all caller profiles, microsecond queueing, and Jito MEV tips
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <SyntheticBanner className="mx-5 mt-3" />

        {/* PARAMETER CONFIGURATION TOOLBAR */}
        <div className="p-3 bg-[#080B12] border-b border-[#1E293B] flex flex-wrap items-center justify-between gap-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {/* Capital Tier Selector */}
            <div className="flex items-center space-x-1 bg-[#101726] p-1 rounded-lg border border-[#1E293B]">
              <span className="text-[10px] text-slate-400 px-1 font-semibold">CAPITAL:</span>
              <button
                onClick={() => setCapitalTier('MICRO_10')}
                className={`px-2 py-1 rounded text-[11px] transition ${
                  capitalTier === 'MICRO_10'
                    ? 'bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                $10 Micro
              </button>
              <button
                onClick={() => setCapitalTier('INSTITUTIONAL')}
                className={`px-2 py-1 rounded text-[11px] transition ${
                  capitalTier === 'INSTITUTIONAL'
                    ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                $500K Inst
              </button>
            </div>

            {/* Co-Location Topology */}
            <div className="flex items-center space-x-1 bg-[#101726] p-1 rounded-lg border border-[#1E293B]">
              <span className="text-[10px] text-slate-400 px-1 font-semibold">CO-LOC:</span>
              <select
                value={coLocation}
                onChange={(e) => setCoLocation(e.target.value as any)}
                className="bg-transparent text-[11px] text-slate-200 focus:outline-none"
              >
                <option value="TOKYO_TY2" className="bg-[#0D131F]">Tokyo TY2 (1.15ms)</option>
                <option value="EQUINIX_NY4" className="bg-[#0D131F]">Equinix NY4 (0.65ms)</option>
                <option value="DUBLIN" className="bg-[#0D131F]">Dublin EU (12.4ms)</option>
                <option value="OREGON" className="bg-[#0D131F]">Oregon US (94.8ms)</option>
              </select>
            </div>

            {/* Strategy Toggles */}
            <div className="flex items-center space-x-1 bg-[#101726] p-1 rounded-lg border border-[#1E293B] text-[10px]">
              <span className="text-slate-400 px-1 font-semibold">STRATS:</span>
              <label className="flex items-center space-x-1 cursor-pointer px-1">
                <input
                  type="checkbox"
                  checked={enableMM}
                  onChange={(e) => setEnableMM(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-700 text-cyan-500"
                />
                <span className={enableMM ? 'text-cyan-300' : 'text-slate-500'}>MM</span>
              </label>
              <label className="flex items-center space-x-1 cursor-pointer px-1">
                <input
                  type="checkbox"
                  checked={enableArb}
                  onChange={(e) => setEnableArb(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-700 text-cyan-500"
                />
                <span className={enableArb ? 'text-indigo-300' : 'text-slate-500'}>Arb</span>
              </label>
              <label className="flex items-center space-x-1 cursor-pointer px-1">
                <input
                  type="checkbox"
                  checked={enableMom}
                  onChange={(e) => setEnableMom(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-700 text-cyan-500"
                />
                <span className={enableMom ? 'text-emerald-300' : 'text-slate-500'}>Mom</span>
              </label>
              <label className="flex items-center space-x-1 cursor-pointer px-1">
                <input
                  type="checkbox"
                  checked={enableSniper}
                  onChange={(e) => setEnableSniper(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-700 text-cyan-500"
                />
                <span className={enableSniper ? 'text-rose-300' : 'text-slate-500'}>Sniper</span>
              </label>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center space-x-2">
            <button
              onClick={executeBacktest}
              disabled={isRunning}
              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold transition flex items-center space-x-1.5 shadow-md shadow-emerald-500/20 disabled:opacity-50"
            >
              {isRunning ? (
                <RotateCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-current" />
              )}
              <span>{isRunning ? 'Simulating 60 Days...' : 'Re-Run 60-Day Backtest'}</span>
            </button>
            <button
              onClick={handleExportJson}
              disabled={!result}
              className="px-2.5 py-1.5 rounded-lg bg-[#141B2D] hover:bg-[#1E293B] border border-[#1E293B] text-slate-300 hover:text-white transition flex items-center space-x-1 text-xs"
              title="Export Backtest Report to JSON"
            >
              <FileDown className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Export</span>
            </button>
          </div>
        </div>

        {/* TOP KPI CARDS */}
        {result && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 p-3 bg-[#0A0F1A] border-b border-[#1E293B] text-xs">
            {/* 1. Net PnL & ROI */}
            <div className="p-2 rounded-lg bg-[#0E1524] border border-[#1E293B]">
              <div className="text-[10px] text-slate-400 font-semibold uppercase">Net 60-Day PnL</div>
              <div className="text-base font-extrabold text-[#00E676] flex items-center space-x-0.5">
                <ArrowUpRight className="w-4 h-4 text-[#00E676]" />
                <span>+${result.netPnL.toLocaleString()}</span>
              </div>
              <div className="text-[10px] text-emerald-400 font-semibold">
                ROI: +{result.roiPct.toLocaleString()}%
              </div>
            </div>

            {/* 2. Starting vs Final Equity */}
            <div className="p-2 rounded-lg bg-[#0E1524] border border-[#1E293B]">
              <div className="text-[10px] text-slate-400 font-semibold uppercase">Capital Growth</div>
              <div className="text-sm font-bold text-white">
                ${result.finalBalance.toLocaleString()}
              </div>
              <div className="text-[10px] text-slate-400">
                From ${result.initialBalance.toLocaleString()}
              </div>
            </div>

            {/* 3. Sharpe Ratio */}
            <div className="p-2 rounded-lg bg-[#0E1524] border border-[#1E293B]">
              <div className="text-[10px] text-slate-400 font-semibold uppercase">Sharpe Ratio</div>
              <div className="text-base font-extrabold text-cyan-400">
                {result.annualizedSharpe}
              </div>
              <div className="text-[10px] text-slate-400">
                Sortino: <span className="text-cyan-300 font-semibold">{result.annualizedSortino}</span>
              </div>
            </div>

            {/* 4. Win Rate */}
            <div className="p-2 rounded-lg bg-[#0E1524] border border-[#1E293B]">
              <div className="text-[10px] text-slate-400 font-semibold uppercase">Trade Win Rate</div>
              <div className="text-base font-extrabold text-emerald-400">
                {result.overallWinRate}%
              </div>
              <div className="text-[10px] text-slate-400">
                {result.totalWins} W / {result.totalLosses} L
              </div>
            </div>

            {/* 5. Max Drawdown */}
            <div className="p-2 rounded-lg bg-[#0E1524] border border-[#1E293B]">
              <div className="text-[10px] text-slate-400 font-semibold uppercase">Max Drawdown</div>
              <div className="text-base font-extrabold text-rose-400">
                -{result.maxDrawdownPct}%
              </div>
              <div className="text-[10px] text-slate-400">
                Calmar: <span className="text-slate-300 font-semibold">{result.calmarRatio}</span>
              </div>
            </div>

            {/* 6. Total Trades & Profit Factor */}
            <div className="p-2 rounded-lg bg-[#0E1524] border border-[#1E293B]">
              <div className="text-[10px] text-slate-400 font-semibold uppercase">Total Trades</div>
              <div className="text-base font-extrabold text-indigo-300">
                {result.totalTrades.toLocaleString()}
              </div>
              <div className="text-[10px] text-slate-400">
                PF: <span className="text-indigo-400 font-semibold">{result.profitFactor}</span>
              </div>
            </div>

            {/* 7. Fees & Jito Tips */}
            <div className="p-2 rounded-lg bg-[#0E1524] border border-[#1E293B]">
              <div className="text-[10px] text-slate-400 font-semibold uppercase">Frictions Paid</div>
              <div className="text-sm font-bold text-amber-300">
                ${result.totalFeesPaid.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-400">
                Jito Tips: <span className="text-amber-400 font-semibold">${result.totalJitoTipsPaid.toFixed(2)}</span>
              </div>
            </div>
          </div>
        )}

        {/* NAVIGATION TABS */}
        <div className="flex items-center space-x-1 px-4 border-b border-[#1E293B] bg-[#0A0D15] text-xs">
          <button
            onClick={() => setActiveTab('EQUITY_CURVE')}
            className={`px-3 py-2.5 font-bold transition flex items-center space-x-1.5 border-b-2 ${
              activeTab === 'EQUITY_CURVE'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            <span>60-Day Equity Curve & Regimes</span>
          </button>
          <button
            onClick={() => setActiveTab('STRATEGY_BREAKDOWN')}
            className={`px-3 py-2.5 font-bold transition flex items-center space-x-1.5 border-b-2 ${
              activeTab === 'STRATEGY_BREAKDOWN'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Strategy Attribution</span>
          </button>
          <button
            onClick={() => setActiveTab('CALLER_ALPHA')}
            className={`px-3 py-2.5 font-bold transition flex items-center space-x-1.5 border-b-2 ${
              activeTab === 'CALLER_ALPHA'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Caller & MM Attribution</span>
          </button>
          <button
            onClick={() => setActiveTab('DAILY_HEATMAP')}
            className={`px-3 py-2.5 font-bold transition flex items-center space-x-1.5 border-b-2 ${
              activeTab === 'DAILY_HEATMAP'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>Daily Calendar PnL</span>
          </button>
          <button
            onClick={() => setActiveTab('TRADE_BLOTTER')}
            className={`px-3 py-2.5 font-bold transition flex items-center space-x-1.5 border-b-2 ${
              activeTab === 'TRADE_BLOTTER'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span>Historical Trade Blotter</span>
          </button>
        </div>

        {/* TAB CONTENTS */}
        <div className="flex-1 overflow-y-auto p-4 bg-[#080B12]">
          {/* TAB 1: 60-DAY EQUITY CURVE */}
          {activeTab === 'EQUITY_CURVE' && (
            <div className="flex flex-col space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  Trajectory: <strong>{result?.startDate}</strong> to <strong>{result?.endDate}</strong> (60 Trading Days)
                </span>
                <span className="text-[11px] text-cyan-400 font-mono">
                  {hoveredDayIndex !== null && result?.dailyRecords[hoveredDayIndex] ? (
                    <span>
                      Day {hoveredDayIndex + 1} ({result.dailyRecords[hoveredDayIndex].dateStr}): Equity ${result.dailyRecords[hoveredDayIndex].cumulativeEquity.toLocaleString()} | Daily PnL: +${result.dailyRecords[hoveredDayIndex].dailyPnL} ({result.dailyRecords[hoveredDayIndex].marketRegime})
                    </span>
                  ) : (
                    'Hover across the curve to inspect daily equity and regime shifts'
                  )}
                </span>
              </div>

              {/* Canvas Container */}
              <div
                className="w-full h-64 sm:h-72 bg-[#06080D] border border-[#1E293B] rounded-lg p-2 relative"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - rect.left - 45;
                  const w = rect.width - 65;
                  const ratio = Math.max(0, Math.min(1, x / w));
                  const dayIdx = Math.round(ratio * 59);
                  setHoveredDayIndex(dayIdx);
                }}
                onMouseLeave={() => setHoveredDayIndex(null)}
              >
                <canvas ref={canvasRef} className="w-full h-full" />
              </div>

              {/* Regime Legend */}
              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                <span className="text-slate-400 font-semibold">REGIMES TESTED:</span>
                <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                  BULL_MOMENTUM
                </span>
                <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/30">
                  MEME_SUPER_CYCLE (High Callout Volume)
                </span>
                <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30">
                  HIGH_VOL_CHOP
                </span>
                <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/30">
                  FLASH_CRASH_REBOUND (Adverse Selection Stress)
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  LOW_VOL_CONSOLIDATION
                </span>
              </div>
            </div>
          )}

          {/* TAB 2: STRATEGY BREAKDOWN */}
          {activeTab === 'STRATEGY_BREAKDOWN' && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#1E293B] bg-[#0F172A] text-slate-400 text-[11px]">
                    <th className="py-2.5 px-3">Strategy</th>
                    <th className="py-2.5 px-3">Trades</th>
                    <th className="py-2.5 px-3">Win Rate</th>
                    <th className="py-2.5 px-3">Gross Profit</th>
                    <th className="py-2.5 px-3">Gross Loss</th>
                    <th className="py-2.5 px-3">Net PnL</th>
                    <th className="py-2.5 px-3">Profit Factor</th>
                    <th className="py-2.5 px-3">Volume Traded</th>
                    <th className="py-2.5 px-3">Contribution</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E293B]">
                  {result?.strategyPerformances.map((s) => (
                    <tr key={s.strategyId} className="hover:bg-[#141E33] transition">
                      <td className="py-2.5 px-3 font-bold text-white flex items-center space-x-1.5">
                        <Zap className="w-3.5 h-3.5 text-cyan-400" />
                        <span>{s.strategyName}</span>
                      </td>
                      <td className="py-2.5 px-3 text-slate-300">{s.totalTrades.toLocaleString()}</td>
                      <td className="py-2.5 px-3 text-emerald-400 font-bold">{s.winRate}%</td>
                      <td className="py-2.5 px-3 text-[#00E676] font-semibold">+${s.grossProfit.toLocaleString()}</td>
                      <td className="py-2.5 px-3 text-rose-400 font-semibold">-${s.grossLoss.toLocaleString()}</td>
                      <td className="py-2.5 px-3 font-extrabold text-[#00E676]">
                        +${s.netPnL.toLocaleString()}
                      </td>
                      <td className="py-2.5 px-3 text-indigo-300 font-bold">{s.profitFactor}</td>
                      <td className="py-2.5 px-3 text-slate-400">${s.volumeTradedUsd.toLocaleString()}</td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center space-x-2">
                          <div className="w-16 bg-[#1E293B] h-1.5 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-cyan-400"
                              style={{ width: `${Math.min(100, s.pnlContributionPct)}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-slate-300 font-bold">{s.pnlContributionPct}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 3: CALLER ALPHA ATTRIBUTION */}
          {activeTab === 'CALLER_ALPHA' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-400">
                Historical performance of top market maker channels & callout bots tracked over the past 60 days:
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {result?.callerPerformances.map((c) => (
                  <div
                    key={c.callerHandle}
                    className="p-3.5 rounded-xl bg-[#0F172A] border border-[#1E293B] flex flex-col justify-between space-y-3 hover:border-cyan-500/40 transition"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-cyan-300 font-sans">{c.callerName}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
                          {c.callerHandle}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-[10px] text-slate-400 block">Total Calls</span>
                          <strong className="text-slate-200">{c.totalCalls}</strong>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 block">2x+ Win Rate</span>
                          <strong className="text-emerald-400 font-bold">{c.winRate2x}%</strong>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 block">Avg Multiple</span>
                          <strong className="text-indigo-300">{c.avgMultiple}x</strong>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 block">Jito Tips Paid</span>
                          <strong className="text-amber-400">${c.totalJitoTipsPaid}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[#1E293B] flex items-center justify-between">
                      <span className="text-[11px] text-slate-400">Attributed Net PnL:</span>
                      <span className="text-sm font-extrabold text-[#00E676] font-mono">
                        +${c.netPnL.toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 4: DAILY CALENDAR HEATMAP */}
          {activeTab === 'DAILY_HEATMAP' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Day-by-Day PnL Grid across all 60 Days:</span>
                <span className="text-[11px] text-slate-500">Green = Profitable Day | Red = Drawdown Day</span>
              </div>
              <div className="grid grid-cols-5 sm:grid-cols-10 md:grid-cols-12 gap-1.5">
                {result?.dailyRecords.map((d) => {
                  const isPositive = d.dailyPnL >= 0;
                  return (
                    <div
                      key={d.dayIndex}
                      title={`Day ${d.dayIndex} (${d.dateStr})\nRegime: ${d.marketRegime}\nPnL: ${isPositive ? '+' : ''}$${d.dailyPnL} (${d.dailyPnLPct}%)\nTrades: ${d.tradesCount} (${d.dailyWinRate}% win)\nEnding: $${d.cumulativeEquity}`}
                      className={`p-1.5 rounded border text-center transition cursor-pointer flex flex-col justify-between h-14 ${
                        isPositive
                          ? 'bg-emerald-950/40 border-emerald-500/30 hover:border-emerald-400'
                          : 'bg-rose-950/40 border-rose-500/30 hover:border-rose-400'
                      }`}
                    >
                      <div className="text-[9px] text-slate-400 font-semibold">D{d.dayIndex}</div>
                      <div
                        className={`text-[10px] font-bold ${
                          isPositive ? 'text-[#00E676]' : 'text-rose-400'
                        }`}
                      >
                        {isPositive ? '+' : ''}${Math.round(d.dailyPnL)}
                      </div>
                      <div className="text-[8px] text-slate-500 font-mono">
                        {d.dailyWinRate}%
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 5: TRADE BLOTTER */}
          {activeTab === 'TRADE_BLOTTER' && (
            <div className="space-y-2.5">
              {/* Blotter Filter Controls */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={tradeSearch}
                    onChange={(e) => setTradeSearch(e.target.value)}
                    placeholder="Search pair, symbol, caller..."
                    className="px-2.5 py-1 rounded bg-[#101726] border border-[#1E293B] text-slate-200 text-xs w-48 focus:outline-none focus:border-cyan-500"
                  />
                  <select
                    value={strategyFilter}
                    onChange={(e) => setStrategyFilter(e.target.value)}
                    className="px-2 py-1 rounded bg-[#101726] border border-[#1E293B] text-slate-300 text-xs focus:outline-none"
                  >
                    <option value="ALL">All Strategies</option>
                    <option value="MARKET_MAKING">Market Making</option>
                    <option value="CROSS_EXCHANGE_ARB">Cross-Exchange Arb</option>
                    <option value="MOMENTUM_SCALPING">Momentum Scalping</option>
                    <option value="PUMP_FUN_SNIPER">Pump.fun Sniper</option>
                  </select>
                </div>
                <span className="text-[11px] text-slate-400">
                  Showing <strong>{filteredTrades.length}</strong> historical trades
                </span>
              </div>

              {/* Trades Table */}
              <div className="overflow-x-auto max-h-80 border border-[#1E293B] rounded-lg">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-[#0E1524] text-slate-400 text-[10px] border-b border-[#1E293B]">
                    <tr>
                      <th className="py-2 px-2.5">Time</th>
                      <th className="py-2 px-2.5">Day</th>
                      <th className="py-2 px-2.5">Strategy</th>
                      <th className="py-2 px-2.5">Symbol</th>
                      <th className="py-2 px-2.5">Side</th>
                      <th className="py-2 px-2.5">Size ($)</th>
                      <th className="py-2 px-2.5">Pnl (%)</th>
                      <th className="py-2 px-2.5">Net PnL</th>
                      <th className="py-2 px-2.5">Jito Tip</th>
                      <th className="py-2 px-2.5">Latency</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1A2333] text-[11px]">
                    {filteredTrades.map((t) => {
                      const isWin = t.netPnL >= 0;
                      return (
                        <tr key={t.id} className="hover:bg-[#141C2E] transition font-mono">
                          <td className="py-1.5 px-2.5 text-slate-400">{t.timestampStr}</td>
                          <td className="py-1.5 px-2.5 text-slate-400">Day {t.dayIndex}</td>
                          <td className="py-1.5 px-2.5 text-slate-300">{t.strategy}</td>
                          <td className="py-1.5 px-2.5 font-bold text-white">
                            {t.symbol}
                            {t.caller && (
                              <span className="ml-1 text-[9px] text-cyan-400">({t.caller})</span>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                                t.side === 'BUY'
                                  ? 'bg-emerald-500/20 text-emerald-300'
                                  : 'bg-rose-500/20 text-rose-300'
                              }`}
                            >
                              {t.side}
                            </span>
                          </td>
                          <td className="py-1.5 px-2.5 text-slate-300">${t.sizeUsd}</td>
                          <td
                            className={`py-1.5 px-2.5 font-bold ${
                              isWin ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {isWin ? '+' : ''}
                            {t.priceChangePct}%
                          </td>
                          <td
                            className={`py-1.5 px-2.5 font-extrabold ${
                              isWin ? 'text-[#00E676]' : 'text-rose-400'
                            }`}
                          >
                            {isWin ? '+' : ''}${t.netPnL}
                          </td>
                          <td className="py-1.5 px-2.5 text-amber-400 font-mono">
                            ${t.jitoTipUsd}
                          </td>
                          <td className="py-1.5 px-2.5 text-slate-400">
                            {t.executionLatencyMs}ms
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div className="px-5 py-3 border-t border-[#1E293B] bg-[#0A0E17] flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center space-x-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>Mathematical Invariants, Almgren-Chriss Impact & Jito Priority Auction Calibrated</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-[#141B2D] hover:bg-[#1E293B] border border-[#1E293B] text-slate-300 hover:text-white transition font-bold"
          >
            Close Backtest
          </button>
        </div>
      </div>
    </div>
  );
};
