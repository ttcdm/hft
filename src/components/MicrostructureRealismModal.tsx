import React, { useState, useEffect } from 'react';
import {
  Globe,
  Server,
  Zap,
  ShieldCheck,
  Percent,
  Layers,
  Cpu,
  RefreshCw,
  Activity,
  Network,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import {
  MicrostructureRealismConfig,
  CoLocationRegion,
  ExchangeFeeTier,
} from '../types';
import { engineClient } from '../services/engineClient';
import { hftAudio } from '../utils/audio';

interface MicrostructureRealismModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAlertTrigger?: (level: 'INFO' | 'WARNING' | 'CRITICAL', title: string, message: string) => void;
}

export const MicrostructureRealismModal: React.FC<MicrostructureRealismModalProps> = ({
  isOpen,
  onClose,
  onAlertTrigger,
}) => {
  const [config, setConfig] = useState<MicrostructureRealismConfig>({
    region: 'AWS_TOKYO_AP_NORTHEAST_1',
    networkLatencyMs: 1.15,
    queuePositionModeling: true,
    toxicFlowAdverseSelection: true,
    feeTier: 'VIP_0',
    makerFeeBps: 8.0,
    takerFeeBps: 10.0,
    slippageModelEnabled: true,
    jitoMevProtection: true,
  });

  const [regions, setRegions] = useState<Record<string, any>>({});
  const [feeSchedules, setFeeSchedules] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      setIsLoading(true);
      try {
        const res = await engineClient.getRealismConfig();
        if (res?.config) setConfig(res.config);
        if (res?.regions) setRegions(res.regions);
        if (res?.feeSchedules) setFeeSchedules(res.feeSchedules);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [isOpen]);

  const handleUpdate = async (partial: Partial<MicrostructureRealismConfig>) => {
    const next = { ...config, ...partial };
    setConfig(next);
    hftAudio.playClick();
    const res = await engineClient.updateRealismConfig(partial);
    if (res?.config) {
      setConfig(res.config);
      onAlertTrigger?.('INFO', 'REALISM CONFIG UPDATED', 'Execution physics and network routing updated.');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-5 overflow-y-auto">
      <div className="relative w-full max-w-4xl bg-[#0B101D] border border-[#1E293B] rounded-2xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden text-slate-200">
        {/* HEADER */}
        <div className="px-5 py-4 border-b border-[#1E293B] bg-[#0E1526] flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-cyan-500/20 border border-cyan-500/40 text-cyan-400">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white tracking-wide">
                Exchange Microstructure &amp; Latency Realism Engine
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Physics-grounded co-location routing, order book queue priority, VIP fee schedules, and adverse selection.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition border border-slate-700"
          >
            Close
          </button>
        </div>

        {/* BODY CONTENT */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs font-mono">
          {/* 1. CO-LOCATION TOPOLOGY */}
          <div className="p-4 rounded-xl bg-[#101728] border border-[#1E293B] space-y-3">
            <div className="flex items-center justify-between border-b border-[#1E293B] pb-2">
              <span className="font-bold text-white flex items-center space-x-2">
                <Server className="w-4 h-4 text-cyan-400" />
                <span>Co-Location &amp; Network Infrastructure Topology</span>
              </span>
              <span className="text-slate-400">Current RTT: <strong className="text-cyan-300">{config.networkLatencyMs.toFixed(2)} ms</strong></span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                {
                  id: 'AWS_TOKYO_AP_NORTHEAST_1',
                  name: 'AWS Tokyo (ap-northeast-1)',
                  rtt: '1.15 ms',
                  tier: 'Institutional Co-Loc',
                  desc: 'Equinix TY2 cross-connect directly adjacent to Binance/Bybit matching engines.',
                },
                {
                  id: 'TOKYO_RETAIL_FIBER',
                  name: 'Tokyo Domestic Fiber',
                  rtt: '18.5 ms',
                  tier: 'Local Retail Broadband',
                  desc: 'Domestic Japanese ISP via public exchange internet gateway.',
                },
                {
                  id: 'AWS_OREGON_US_WEST_2',
                  name: 'US West / Oregon (us-west-2)',
                  rtt: '94.8 ms',
                  tier: 'Trans-Pacific Subsea Cable',
                  desc: 'FASTER/Unity subsea fiber cable spanning Pacific Ocean (West Coast to Tokyo).',
                },
                {
                  id: 'AWS_FRANKFURT_EU_CENTRAL_1',
                  name: 'Europe / Frankfurt (eu-central-1)',
                  rtt: '184.2 ms',
                  tier: 'Trans-Continental Transit',
                  desc: 'Eurasian terrestrial fiber hop routing through Suez / Middle East.',
                },
              ].map((loc) => {
                const isSelected = config.region === loc.id;
                return (
                  <div
                    key={loc.id}
                    onClick={() => handleUpdate({ region: loc.id as CoLocationRegion })}
                    className={`p-3 rounded-lg border cursor-pointer transition ${
                      isSelected
                        ? 'bg-cyan-950/40 border-cyan-400 shadow-md shadow-cyan-950/30'
                        : 'bg-[#141B2D] border-[#1E293B] hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-white text-xs">{loc.name}</span>
                      <span className="text-cyan-400 font-bold">{loc.rtt}</span>
                    </div>
                    <div className="text-[10px] text-amber-300 mb-1">{loc.tier}</div>
                    <p className="text-[11px] text-slate-400 font-sans leading-normal">{loc.desc}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2. VIP FEE SCHEDULE MATRIX */}
          <div className="p-4 rounded-xl bg-[#101728] border border-[#1E293B] space-y-3">
            <div className="flex items-center justify-between border-b border-[#1E293B] pb-2">
              <span className="font-bold text-white flex items-center space-x-2">
                <Percent className="w-4 h-4 text-amber-400" />
                <span>Exchange Fee Schedule Matrix</span>
              </span>
              <span className="text-slate-400">
                Maker: <strong className="text-emerald-400">{config.makerFeeBps} bps</strong> | Taker: <strong className="text-rose-400">{config.takerFeeBps} bps</strong>
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { id: 'VIP_0', name: 'VIP 0 Retail', maker: '8.0 bps (0.08%)', taker: '10.0 bps (0.10%)' },
                { id: 'VIP_1', name: 'VIP 1 Active', maker: '6.0 bps (0.06%)', taker: '8.0 bps (0.08%)' },
                { id: 'VIP_4', name: 'VIP 4 Semi-Pro', maker: '2.5 bps (0.025%)', taker: '4.5 bps (0.045%)' },
                { id: 'VIP_9_NEGATIVE_MAKER', name: 'VIP 9 Institutional MM', maker: '-0.5 bps (Rebate)', taker: '1.8 bps (0.018%)' },
              ].map((tier) => {
                const isSelected = config.feeTier === tier.id;
                return (
                  <button
                    key={tier.id}
                    onClick={() => handleUpdate({ feeTier: tier.id as ExchangeFeeTier })}
                    className={`p-2.5 rounded-lg border text-left transition ${
                      isSelected
                        ? 'bg-amber-950/40 border-amber-400 text-amber-200'
                        : 'bg-[#141B2D] border-[#1E293B] text-slate-300 hover:text-white'
                    }`}
                  >
                    <div className="font-bold text-xs mb-1">{tier.name}</div>
                    <div className="text-[10px] text-emerald-400">Maker: {tier.maker}</div>
                    <div className="text-[10px] text-rose-400">Taker: {tier.taker}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. ORDER BOOK MICROSTRUCTURE MECHANICS */}
          <div className="p-4 rounded-xl bg-[#101728] border border-[#1E293B] space-y-4">
            <span className="font-bold text-white flex items-center space-x-2 border-b border-[#1E293B] pb-2">
              <Layers className="w-4 h-4 text-purple-400" />
              <span>Microstructure Mechanics &amp; Fill Physics</span>
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Queue Position Modeling */}
              <div className="flex items-start justify-between p-3 rounded-lg bg-[#141B2D] border border-[#1E293B]">
                <div className="pr-3">
                  <div className="font-bold text-white text-xs mb-1">Queue Priority (FIFO) Modeling</div>
                  <p className="text-[11px] text-slate-400 font-sans leading-relaxed">
                    Limit orders must wait for aggressive taker volume to deplete existing liquidity ahead in line. Eliminates unrealistic instant fills.
                  </p>
                </div>
                <button
                  onClick={() => handleUpdate({ queuePositionModeling: !config.queuePositionModeling })}
                  className={`px-3 py-1 rounded text-xs font-bold transition ${
                    config.queuePositionModeling ? 'bg-emerald-500 text-black' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {config.queuePositionModeling ? 'ENABLED' : 'DISABLED'}
                </button>
              </div>

              {/* Toxic Flow Adverse Selection */}
              <div className="flex items-start justify-between p-3 rounded-lg bg-[#141B2D] border border-[#1E293B]">
                <div className="pr-3">
                  <div className="font-bold text-white text-xs mb-1">Toxic Flow Adverse Selection</div>
                  <p className="text-[11px] text-slate-400 font-sans leading-relaxed">
                    Fills occurring during sharp price jumps suffer adverse price drifts immediately after execution, matching institutional LP conditions.
                  </p>
                </div>
                <button
                  onClick={() => handleUpdate({ toxicFlowAdverseSelection: !config.toxicFlowAdverseSelection })}
                  className={`px-3 py-1 rounded text-xs font-bold transition ${
                    config.toxicFlowAdverseSelection ? 'bg-emerald-500 text-black' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {config.toxicFlowAdverseSelection ? 'ENABLED' : 'DISABLED'}
                </button>
              </div>

              {/* Square Root Market Impact */}
              <div className="flex items-start justify-between p-3 rounded-lg bg-[#141B2D] border border-[#1E293B]">
                <div className="pr-3">
                  <div className="font-bold text-white text-xs mb-1">Square-Root Market Impact Law</div>
                  <p className="text-[11px] text-slate-400 font-sans leading-relaxed">
                    Calculates slippage via &ldquo;I = Y &middot; &sigma; &middot; &radic;(Q / V)&rdquo;. Larger orders penetrate deeper into order book depth.
                  </p>
                </div>
                <button
                  onClick={() => handleUpdate({ slippageModelEnabled: !config.slippageModelEnabled })}
                  className={`px-3 py-1 rounded text-xs font-bold transition ${
                    config.slippageModelEnabled ? 'bg-emerald-500 text-black' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {config.slippageModelEnabled ? 'ENABLED' : 'DISABLED'}
                </button>
              </div>

              {/* Jito MEV Protection */}
              <div className="flex items-start justify-between p-3 rounded-lg bg-[#141B2D] border border-[#1E293B]">
                <div className="pr-3">
                  <div className="font-bold text-white text-xs mb-1">Jito MEV Sandwich Protection</div>
                  <p className="text-[11px] text-slate-400 font-sans leading-relaxed">
                    Routes on-chain memecoin swaps directly to validator block builders via bundles, bypassing public mempool sandwich bots.
                  </p>
                </div>
                <button
                  onClick={() => handleUpdate({ jitoMevProtection: !config.jitoMevProtection })}
                  className={`px-3 py-1 rounded text-xs font-bold transition ${
                    config.jitoMevProtection ? 'bg-emerald-500 text-black' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {config.jitoMevProtection ? 'ACTIVE' : 'OFF'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
