import React, { useRef, useEffect, useState } from 'react';
import { PieChart, TrendingUp, RefreshCw, Layers } from 'lucide-react';
import { generateMonteCarloTrajectories } from '../utils/math';

interface MonteCarloAnalyticsProps {
  currentPrice: number;
  onOpenBacktest?: () => void;
}

export const MonteCarloAnalytics: React.FC<MonteCarloAnalyticsProps> = ({
  currentPrice,
  onOpenBacktest,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [simulationData, setSimulationData] = useState(() =>
    generateMonteCarloTrajectories(currentPrice || 68900)
  );

  const regenerate = () => {
    setSimulationData(generateMonteCarloTrajectories(currentPrice || 68900));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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

    const { p05, p50, p95, samplePaths, steps } = simulationData;
    const allVals = [...p05, ...p95, ...samplePaths.flat()];
    const minVal = Math.min(...allVals) * 0.995;
    const maxVal = Math.max(...allVals) * 1.005;
    const range = maxVal - minVal;

    // Grid lines
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (let i = 1; i <= 3; i++) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 1. Fill 90% Confidence Interval Band (between p05 and p95)
    ctx.beginPath();
    p95.forEach((val, i) => {
      const x = (width / (steps.length - 1)) * i;
      const y = height - ((val - minVal) / range) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let i = p05.length - 1; i >= 0; i--) {
      const val = p05[i];
      const x = (width / (steps.length - 1)) * i;
      const y = height - ((val - minVal) / range) * height;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 229, 255, 0.08)';
    ctx.fill();

    // 2. Render individual synthetic sample paths (8 trajectories)
    const pathColors = [
      'rgba(0, 230, 118, 0.35)',
      'rgba(41, 121, 255, 0.35)',
      'rgba(0, 229, 255, 0.35)',
      'rgba(255, 214, 0, 0.35)',
      'rgba(255, 23, 68, 0.35)',
      'rgba(168, 85, 247, 0.35)',
      'rgba(56, 189, 248, 0.35)',
      'rgba(244, 63, 94, 0.35)',
    ];

    samplePaths.forEach((path, pIdx) => {
      ctx.beginPath();
      path.forEach((val, i) => {
        const x = (width / (steps.length - 1)) * i;
        const y = height - ((val - minVal) / range) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = pathColors[pIdx % pathColors.length];
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // 3. Median Trajectory (p50)
    ctx.beginPath();
    p50.forEach((val, i) => {
      const x = (width / (steps.length - 1)) * i;
      const y = height - ((val - minVal) / range) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#00E5FF';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Callout labels
    ctx.fillStyle = '#00E5FF';
    ctx.font = '10px JetBrains Mono, monospace';
    const lastP50 = p50[p50.length - 1];
    const lastY = height - ((lastP50 - minVal) / range) * height;
    ctx.fillText(`Median: $${lastP50.toFixed(0)}`, width - 95, Math.max(15, lastY - 4));
  }, [simulationData]);

  return (
    <div
      id="institutional-analytics"
      className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-4 shadow-xl flex flex-col space-y-4"
    >
      {/* HEADER */}
      <div className="flex items-center justify-between pb-2 border-b border-[#1E293B]">
        <div className="flex items-center space-x-2">
          <TrendingUp className="w-4 h-4 text-cyan-400" />
          <h3 className="text-xs font-bold text-white uppercase font-mono tracking-wider">
            Monte Carlo 1,000-Path Future Simulation
          </h3>
        </div>

        <div className="flex items-center space-x-2">
          {onOpenBacktest && (
            <button
              onClick={onOpenBacktest}
              className="text-[10px] font-mono text-emerald-300 hover:text-white flex items-center space-x-1 px-2.5 py-0.5 rounded bg-emerald-950/40 hover:bg-emerald-900/60 border border-emerald-500/30 transition"
              title="Launch 60-Day Multi-Strategy Historical Backtest Engine"
            >
              <TrendingUp className="w-3 h-3 text-emerald-400" />
              <span>60-Day Backtest</span>
            </button>
          )}
          <button
            onClick={regenerate}
            className="text-[10px] font-mono text-cyan-400 hover:text-white flex items-center space-x-1 px-2 py-0.5 rounded bg-[#141B2D] border border-[#1E293B]"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Re-Simulate</span>
          </button>
        </div>
      </div>

      {/* MULTI-ASSET EXPOSURE ALLOCATION BAR */}
      <div>
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mb-1">
          <span>Multi-Asset Portfolio Exposure</span>
          <span className="text-slate-300">Total Net Delta: $1,245,000</span>
        </div>

        <div className="h-3 w-full rounded overflow-hidden flex font-mono text-[9px] font-bold text-black">
          <div
            style={{ width: '45%' }}
            className="bg-[#00E676] flex items-center justify-center truncate px-1"
            title="Crypto 45%"
          >
            CRYPTO 45%
          </div>
          <div
            style={{ width: '35%' }}
            className="bg-[#2979FF] text-white flex items-center justify-center truncate px-1"
            title="Equities 35%"
          >
            EQUITY 35%
          </div>
          <div
            style={{ width: '15%' }}
            className="bg-[#FFD600] flex items-center justify-center truncate px-1"
            title="FX 15%"
          >
            FX 15%
          </div>
          <div
            style={{ width: '5%' }}
            className="bg-[#FF1744] text-white flex items-center justify-center truncate px-1"
            title="Commodities 5%"
          >
            5%
          </div>
        </div>
      </div>

      {/* MONTE CARLO CANVAS VISUALIZER */}
      <div className="h-44 w-full relative">
        <canvas
          ref={canvasRef}
          className="w-full h-full rounded-lg bg-[#06080D] border border-[#1E293B]/80"
        />
      </div>

      {/* CONFIDENCE STATS FOOTER */}
      <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono pt-1">
        <div className="p-1.5 rounded bg-[#141B2D]/60 border border-[#1E293B]/60">
          <span className="text-slate-500 block text-[9px]">5th %-tile (Bear Case)</span>
          <span className="text-red-400 font-bold text-xs">
            ${simulationData.p05[simulationData.p05.length - 1].toFixed(0)}
          </span>
        </div>
        <div className="p-1.5 rounded bg-[#141B2D]/60 border border-[#1E293B]/60">
          <span className="text-slate-500 block text-[9px]">50th %-tile (Median)</span>
          <span className="text-cyan-400 font-bold text-xs">
            ${simulationData.p50[simulationData.p50.length - 1].toFixed(0)}
          </span>
        </div>
        <div className="p-1.5 rounded bg-[#141B2D]/60 border border-[#1E293B]/60">
          <span className="text-slate-500 block text-[9px]">95th %-tile (Bull Case)</span>
          <span className="text-[#00E676] font-bold text-xs">
            ${simulationData.p95[simulationData.p95.length - 1].toFixed(0)}
          </span>
        </div>
      </div>
    </div>
  );
};
