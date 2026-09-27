import React, { useRef, useEffect } from 'react';
import { TrendingUp, TrendingDown, Shield, Award, BarChart2 } from 'lucide-react';
import { PerformanceKPIs } from '../types';

interface PnLEngineProps {
  kpis: PerformanceKPIs;
  equityHistory: number[];
  drawdownHistory: number[];
  lastTickDelta: number;
  isHalted: boolean;
}

export const PnLEngine: React.FC<PnLEngineProps> = ({
  kpis,
  equityHistory,
  drawdownHistory,
  lastTickDelta,
  isHalted,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Render Hardware-Accelerated Equity Curve on Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || equityHistory.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.floor(width * dpr);
    const targetHeight = Math.floor(height * dpr);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const minVal = Math.min(...equityHistory) * 0.998;
    const maxVal = Math.max(...equityHistory) * 1.002;
    const range = Math.max(1, maxVal - minVal);

    // 1. Background Grid Lines & Drawdown Bar Zone (Bottom 25%)
    const chartHeight = height * 0.75;
    const ddHeight = height * 0.25;
    const ddTop = chartHeight;

    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    for (let i = 1; i <= 3; i++) {
      const y = (chartHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Divider between equity curve and drawdown bars
    ctx.setLineDash([]);
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(0, ddTop);
    ctx.lineTo(width, ddTop);
    ctx.stroke();

    // 2. High-Water Mark peak line
    const peakY = chartHeight - ((kpis.peakEquity - minVal) / range) * chartHeight;
    ctx.strokeStyle = 'rgba(0, 230, 118, 0.4)';
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(0, peakY);
    ctx.lineTo(width, peakY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#00E676';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillText(`HWM: $${kpis.peakEquity.toLocaleString('en-US', { maximumFractionDigits: 0 })}`, width - 90, Math.max(12, peakY - 3));

    // 3. Drawdown Bars in Bottom Zone
    const barWidth = width / Math.max(1, drawdownHistory.length);
    const maxDdObserved = Math.max(0.01, ...drawdownHistory);
    drawdownHistory.forEach((dd, i) => {
      const barH = (dd / maxDdObserved) * (ddHeight - 4);
      const x = i * barWidth;
      const y = height - barH;
      ctx.fillStyle = dd > 0.01 ? 'rgba(255, 23, 68, 0.45)' : 'rgba(255, 23, 68, 0.2)';
      ctx.fillRect(x, y, Math.max(1, barWidth - 1), barH);
    });

    // 4. Gradient Fill under Equity Curve
    const isProfitable = kpis.dailyPnL >= 0;
    const gradient = ctx.createLinearGradient(0, 0, 0, chartHeight);
    if (isProfitable) {
      gradient.addColorStop(0, 'rgba(0, 230, 118, 0.25)');
      gradient.addColorStop(0.8, 'rgba(0, 230, 118, 0.02)');
      gradient.addColorStop(1, 'rgba(0, 230, 118, 0.0)');
    } else {
      gradient.addColorStop(0, 'rgba(255, 23, 68, 0.25)');
      gradient.addColorStop(1, 'rgba(255, 23, 68, 0.0)');
    }

    ctx.beginPath();
    equityHistory.forEach((val, i) => {
      const x = (width / Math.max(1, equityHistory.length - 1)) * i;
      const y = chartHeight - ((val - minVal) / range) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(width, chartHeight);
    ctx.lineTo(0, chartHeight);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 5. Equity Line Path
    ctx.beginPath();
    equityHistory.forEach((val, i) => {
      const x = (width / Math.max(1, equityHistory.length - 1)) * i;
      const y = chartHeight - ((val - minVal) / range) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = isProfitable ? '#00E676' : '#FF1744';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 6. Current Head Pulse Marker
    if (equityHistory.length > 0) {
      const lastX = width;
      const lastVal = equityHistory[equityHistory.length - 1];
      const lastY = chartHeight - ((lastVal - minVal) / range) * chartHeight;

      ctx.beginPath();
      ctx.arc(lastX - 2, lastY, 4, 0, Math.PI * 2);
      ctx.fillStyle = isProfitable ? '#00E676' : '#FF1744';
      ctx.fill();
    }
  }, [equityHistory, drawdownHistory, kpis.peakEquity, kpis.dailyPnL]);

  const isProfitable = kpis.dailyPnL >= 0;

  return (
    <div className="space-y-4">
      {/* REAL-TIME P&L HUD CARD */}
      <div
        id="live-pnl-card"
        className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-5 shadow-2xl relative overflow-hidden transition-all duration-200"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center space-x-2">
            <span className="h-2 w-2 rounded-full bg-cyan-400 animate-ping"></span>
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
              Net Realized & Unrealized P&L
            </span>
            <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30">
              Simulated CEX Paper Tape
            </span>
          </div>
          <span
            className={`text-xs px-2.5 py-0.5 rounded font-mono font-bold border ${
              isHalted
                ? 'bg-red-500/10 text-red-400 border-red-500/30'
                : isProfitable
                ? 'bg-[#00E676]/10 text-[#00E676] border-[#00E676]/30'
                : 'bg-red-500/10 text-red-400 border-red-500/30'
            }`}
          >
            {isHalted
              ? 'HALTED (KILL SWITCH)'
              : isProfitable
              ? `PROFITABLE (+${((kpis.dailyPnL / 500000) * 100).toFixed(2)}%)`
              : `DRAWDOWN (${((kpis.dailyPnL / 500000) * 100).toFixed(2)}%)`}
          </span>
        </div>

        {/* Big PnL Display with Micro-Tick Flash */}
        <div className="flex items-baseline space-x-3 my-2">
          <span
            className={`text-3xl sm:text-4xl font-black font-mono tracking-tight transition-colors duration-200 ${
              isProfitable ? 'text-[#00E676] drop-shadow-[0_0_15px_rgba(0,230,118,0.35)]' : 'text-red-500 drop-shadow-[0_0_15px_rgba(255,23,68,0.35)]'
            }`}
          >
            {isProfitable ? '+' : '-'}${Math.abs(kpis.dailyPnL).toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          <span
            className={`text-xs font-mono font-bold flex items-center ${
              lastTickDelta >= 0 ? 'text-[#00E676]' : 'text-red-500'
            }`}
          >
            {lastTickDelta >= 0 ? (
              <TrendingUp className="w-3.5 h-3.5 mr-0.5 inline" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5 mr-0.5 inline" />
            )}
            {lastTickDelta >= 0 ? '+' : ''}${lastTickDelta.toFixed(2)}
          </span>
        </div>

        {/* Secondary Total Account Equity */}
        <div className="flex items-center justify-between text-xs font-mono text-slate-400 pt-1 pb-3 border-b border-[#1E293B]">
          <span>
            Total Nav Equity: <strong className="text-white">${kpis.totalEquity.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
          </span>
          <span>
            Unrealized Floating: <span className={kpis.unrealizedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {kpis.unrealizedPnL >= 0 ? '+' : ''}${kpis.unrealizedPnL.toFixed(2)}
            </span>
          </span>
        </div>

        {/* INSTITUTIONAL RISK MATRIX METRICS */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 pt-3 text-xs font-mono">
          <div className="p-1.5 rounded bg-[#141B2D]/60 border border-[#1E293B]/60">
            <span className="text-slate-400 block text-[9px] uppercase tracking-wider">Sharpe</span>
            <span className="text-cyan-400 font-bold text-xs">{kpis.sharpeRatio.toFixed(2)}</span>
          </div>

          <div className="p-1.5 rounded bg-[#141B2D]/60 border border-[#1E293B]/60">
            <span className="text-slate-400 block text-[9px] uppercase tracking-wider">Sortino</span>
            <span className="text-emerald-400 font-bold text-xs">{kpis.sortinoRatio.toFixed(2)}</span>
          </div>

          <div className="p-1.5 rounded bg-[#141B2D]/60 border border-[#1E293B]/60">
            <span className="text-slate-400 block text-[9px] uppercase tracking-wider">Profit Fac</span>
            <span className="text-white font-bold text-xs">{kpis.profitFactor.toFixed(2)}</span>
          </div>

          <div className="p-1.5 rounded bg-[#141B2D]/60 border border-[#1E293B]/60">
            <span className="text-slate-400 block text-[9px] uppercase tracking-wider">Win Rate</span>
            <span className="text-[#00E676] font-bold text-xs">{kpis.winRate.toFixed(1)}%</span>
          </div>

          <div className="p-1.5 rounded bg-[#141B2D]/60 border border-[#1E293B]/60">
            <span className="text-slate-400 block text-[9px] uppercase tracking-wider">99% VaR</span>
            <span className="text-amber-400 font-bold text-xs">{(kpis.var99Pct * 100).toFixed(2)}%</span>
          </div>

          <div className="p-1.5 rounded bg-[#141B2D]/60 border border-[#1E293B]/60">
            <span className="text-slate-400 block text-[9px] uppercase tracking-wider">Max DD</span>
            <span className="text-red-400 font-bold text-xs">{(kpis.maxDrawdownPct * 100).toFixed(2)}%</span>
          </div>
        </div>
      </div>

      {/* HARDWARE-ACCELERATED REAL-TIME EQUITY CURVE WITH DRAWDOWN BARS */}
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-4 shadow-xl flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center space-x-2">
            <BarChart2 className="w-3.5 h-3.5 text-cyan-400" />
            <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
              High-Frequency Equity Curve & Rolling Drawdown
            </h3>
          </div>
          <div className="flex items-center space-x-3 text-[10px] font-mono text-slate-400">
            <span className="flex items-center space-x-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[#00E676]"></span>
              <span>250ms Micro-Tick</span>
            </span>
            <span className="text-slate-500">|</span>
            <span>Rolling Drawdown Bars (Bottom)</span>
          </div>
        </div>

        <div className="h-56 w-full relative">
          <canvas
            ref={canvasRef}
            className="w-full h-full rounded-lg bg-[#06080D] border border-[#1E293B]/80"
          />
        </div>
      </div>
    </div>
  );
};
