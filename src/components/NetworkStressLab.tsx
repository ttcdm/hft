import React, { useState } from 'react';
import {
  Zap,
  Activity,
  AlertTriangle,
  Play,
  Download,
  Gauge,
  Sliders,
  CheckCircle,
  Clock,
  Radio,
} from 'lucide-react';
import { NetworkStressConfig, JitterProfileType } from '../types';

interface NetworkStressLabProps {
  stressConfig: NetworkStressConfig;
  onUpdateConfig: (config: NetworkStressConfig) => void;
  currentEffectiveLatency: number;
  currentSlippageMultiplier: number;
  fillRatePct: number;
  latencySamples: number[];
  onExportPackets: () => void;
}

export const NetworkStressLab: React.FC<NetworkStressLabProps> = ({
  stressConfig,
  onUpdateConfig,
  currentEffectiveLatency,
  currentSlippageMultiplier,
  fillRatePct,
  latencySamples,
  onExportPackets,
}) => {
  const [probeTarget, setProbeTarget] = useState('cme');
  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<any>(null);

  const toggleStress = () => {
    onUpdateConfig({
      ...stressConfig,
      isStressActive: !stressConfig.isStressActive,
    });
  };

  const handleProfileSelect = (p: JitterProfileType) => {
    onUpdateConfig({
      ...stressConfig,
      profile: p,
      isStressActive: true,
      jitterMs: p === 'PARETO_BURST' ? 18.5 : p === 'MICROWAVE_FADE' ? 12.0 : 4.5,
      packetLossPct: p === 'CIRCUIT_BREAKER' ? 100 : p === 'PARETO_BURST' ? 8.5 : 2.0,
    });
  };

  // Run automated latency probe against real APIs through the backend
  const runLiveLatencyProbe = async () => {
    setIsProbing(true);
    setProbeResult(null);
    try {
      const res = await fetch('/api/latency-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: probeTarget,
          samples: 8,
          injectedJitterMs: stressConfig.isStressActive ? stressConfig.jitterMs : 0,
          packetLossRate: stressConfig.isStressActive ? stressConfig.packetLossPct : 0,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setProbeResult(data);
      }
    } catch (e) {
      console.error('Probe failed:', e);
    } finally {
      setIsProbing(false);
    }
  };

  // Generate P99 Latency Histogram buckets from rolling samples
  const bins = [0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0];
  const histogramCounts = bins.map((binLimit, i) => {
    const prevLimit = i === 0 ? 0 : bins[i - 1];
    return latencySamples.filter((s) => s >= prevLimit && s < binLimit).length;
  });
  const maxBinCount = Math.max(1, ...histogramCounts);

  return (
    <div
      id="network-stress-jitter-lab"
      className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-4 shadow-xl flex flex-col space-y-4"
    >
      {/* HEADER */}
      <div className="flex items-center justify-between pb-2 border-b border-[#1E293B]">
        <div className="flex items-center space-x-2">
          <Zap className="w-4 h-4 text-amber-400" />
          <h3 className="text-xs font-bold text-white uppercase font-mono tracking-wider">
            Network Stress & Jitter Injection Lab
          </h3>
        </div>

        {/* Master Stress Toggle */}
        <div className="flex items-center space-x-2">
          <span className="text-[10px] font-mono text-slate-400">
            {stressConfig.isStressActive ? 'DEGRADATION ACTIVE' : 'CLEAN CO-LOC'}
          </span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={stressConfig.isStressActive}
              onChange={toggleStress}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-[#1E293B] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
          </label>
        </div>
      </div>

      {/* JITTER PROFILES SELECTOR */}
      <div>
        <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
          <span>Congestion Profile</span>
          <span className="text-cyan-400 font-bold">{stressConfig.profile}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {[
            { id: 'GAUSSIAN', label: 'Gaussian Noise' },
            { id: 'PARETO_BURST', label: 'Pareto Burst' },
            { id: 'MICROWAVE_FADE', label: 'Microwave Fade' },
            { id: 'CIRCUIT_BREAKER', label: 'Exchange Halt' },
          ].map((prof) => (
            <button
              key={prof.id}
              onClick={() => handleProfileSelect(prof.id as any)}
              className={`p-1.5 rounded text-[10px] font-mono font-semibold border transition text-center ${
                stressConfig.profile === prof.id
                  ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                  : 'bg-[#141B2D] border-[#1E293B] text-slate-400 hover:text-white'
              }`}
            >
              {prof.label}
            </button>
          ))}
        </div>
      </div>

      {/* SLIDER CONTROLS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
        <div>
          <div className="flex justify-between text-slate-400 mb-1 text-[11px]">
            <span>Base Latency Spike</span>
            <span className="text-cyan-400 font-bold">{stressConfig.baseLatencyMs.toFixed(1)} ms</span>
          </div>
          <input
            type="range"
            min="0.4"
            max="120"
            step="0.5"
            value={stressConfig.baseLatencyMs}
            onChange={(e) =>
              onUpdateConfig({
                ...stressConfig,
                baseLatencyMs: parseFloat(e.target.value),
              })
            }
            className="w-full accent-cyan-400 bg-[#141B2D] h-1.5 rounded cursor-pointer"
          />
        </div>

        <div>
          <div className="flex justify-between text-slate-400 mb-1 text-[11px]">
            <span>Packet Drop Rate</span>
            <span className="text-red-400 font-bold">{stressConfig.packetLossPct.toFixed(1)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="35"
            step="0.5"
            value={stressConfig.packetLossPct}
            onChange={(e) =>
              onUpdateConfig({
                ...stressConfig,
                packetLossPct: parseFloat(e.target.value),
              })
            }
            className="w-full accent-red-500 bg-[#141B2D] h-1.5 rounded cursor-pointer"
          />
        </div>
      </div>

      {/* LIVE DEGRADATION TELEMETRY STATS */}
      <div className="grid grid-cols-3 gap-2 p-2.5 rounded-lg bg-[#06080D] border border-[#1E293B] text-xs font-mono">
        <div>
          <span className="text-slate-500 block text-[9px] uppercase">Effective Latency</span>
          <span
            className={`font-bold text-sm ${
              currentEffectiveLatency > 5 ? 'text-amber-400' : 'text-cyan-400'
            }`}
          >
            {currentEffectiveLatency.toFixed(2)} ms
          </span>
        </div>

        <div>
          <span className="text-slate-500 block text-[9px] uppercase">Slippage Multiplier</span>
          <span
            className={`font-bold text-sm ${
              currentSlippageMultiplier > 2.5 ? 'text-red-400' : 'text-slate-200'
            }`}
          >
            {currentSlippageMultiplier.toFixed(2)}x
          </span>
        </div>

        <div>
          <span className="text-slate-500 block text-[9px] uppercase">Trade Fill Rate</span>
          <span
            className={`font-bold text-sm ${
              fillRatePct > 90 ? 'text-[#00E676]' : fillRatePct > 70 ? 'text-amber-400' : 'text-red-400'
            }`}
          >
            {fillRatePct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* P99 LATENCY HISTOGRAM */}
      <div>
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mb-1.5">
          <span className="uppercase font-bold">P99 Latency Histogram (Rolling Samples)</span>
          <span className="text-cyan-400">Total: {latencySamples.length} ticks</span>
        </div>

        <div className="h-20 flex items-end space-x-1.5 bg-[#06080D] p-2 rounded-lg border border-[#1E293B]">
          {bins.map((binLimit, i) => {
            const count = histogramCounts[i];
            const heightPct = Math.max(8, (count / maxBinCount) * 100);
            const isHigh = binLimit > 10;
            return (
              <div key={binLimit} className="flex-1 flex flex-col items-center h-full justify-end group relative">
                <div
                  style={{ height: `${heightPct}%` }}
                  className={`w-full rounded-t transition-all duration-300 ${
                    isHigh
                      ? 'bg-gradient-to-t from-red-600 to-amber-500'
                      : 'bg-gradient-to-t from-cyan-600 to-cyan-400'
                  }`}
                />
                <span className="text-[8px] font-mono text-slate-500 mt-1">
                  &lt;{binLimit}ms
                </span>

                {/* Tooltip */}
                <div className="absolute -top-7 hidden group-hover:block bg-[#1E293B] text-[9px] font-mono text-white px-1.5 py-0.5 rounded shadow z-10 whitespace-nowrap">
                  {count} trades
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* AUTOMATED LATENCY TESTER AGAINST REAL PUBLIC EXCHANGE ENDPOINTS */}
      <div className="p-3 rounded-lg bg-[#141B2D]/70 border border-[#1E293B] text-xs font-mono">
        <div className="flex items-center justify-between mb-2">
          <span className="text-slate-300 font-bold text-[11px] flex items-center space-x-1">
            <Radio className="w-3.5 h-3.5 text-cyan-400" />
            <span>Automated Real-API Latency Probe</span>
          </span>

          <div className="flex items-center space-x-2">
            <select
              value={probeTarget}
              onChange={(e) => setProbeTarget(e.target.value)}
              className="bg-[#0D131F] border border-[#1E293B] rounded px-2 py-0.5 text-[10px] text-slate-300"
            >
              <option value="cme">CME Group Feed</option>
              <option value="binance">Binance Exchange REST</option>
              <option value="coinbase">Coinbase Pro Atomic Clock</option>
              <option value="kraken">Kraken System Time</option>
            </select>

            <button
              onClick={runLiveLatencyProbe}
              disabled={isProbing}
              className="px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-[10px] flex items-center space-x-1 transition"
            >
              <Play className="w-2.5 h-2.5" />
              <span>{isProbing ? 'Probing...' : 'Run Probe'}</span>
            </button>
          </div>
        </div>

        {probeResult && (
          <div className="grid grid-cols-4 gap-2 pt-2 mt-2 border-t border-[#1E293B] text-[10px]">
            <div>
              <span className="text-slate-500 block">Avg RTT:</span>
              <span className="text-cyan-400 font-bold">{probeResult.avgLatencyMs} ms</span>
            </div>
            <div>
              <span className="text-slate-500 block">p90 Latency:</span>
              <span className="text-white font-bold">{probeResult.p90Ms} ms</span>
            </div>
            <div>
              <span className="text-slate-500 block">p99 Latency:</span>
              <span className="text-amber-400 font-bold">{probeResult.p99Ms} ms</span>
            </div>
            <div>
              <span className="text-slate-500 block">Packet Loss:</span>
              <span className={probeResult.packetLossPct > 0 ? 'text-red-400 font-bold' : 'text-[#00E676]'}>
                {probeResult.packetLossPct}%
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
