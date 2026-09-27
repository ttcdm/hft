import React, { useState } from 'react';
import { Bot, Zap, Plus, X } from 'lucide-react';
import { TradingBot, StrategyArchetype, AssetClass } from '../types';

interface DeployBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDeploy: (bot: TradingBot) => void;
}

const PRESET_STRATEGIES = [
  {
    name: 'Optiver Cointegration Arbitrage',
    archetype: 'STATISTICAL_ARBITRAGE' as StrategyArchetype,
    assetClass: 'CRYPTO' as AssetClass,
    symbol: 'BTC/USDT-ETH/USDT',
    opsPerSec: 195,
    maxDailyLoss: 5000,
    slippageLimitBps: 1.5,
    leverage: 10,
    winRate: 72.4,
  },
  {
    name: 'Jump Micro-Maker V4',
    archetype: 'MARKET_MAKING' as StrategyArchetype,
    assetClass: 'EQUITIES' as AssetClass,
    symbol: 'NVDA/USD',
    opsPerSec: 240,
    maxDailyLoss: 7500,
    slippageLimitBps: 1.2,
    leverage: 8,
    winRate: 68.2,
  },
  {
    name: 'Flow Imbalance Sentinel',
    archetype: 'ORDER_BOOK_IMBALANCE' as StrategyArchetype,
    assetClass: 'CRYPTO' as AssetClass,
    symbol: 'SOL/USDT',
    opsPerSec: 160,
    maxDailyLoss: 3000,
    slippageLimitBps: 2.0,
    leverage: 5,
    winRate: 65.8,
  },
  {
    name: 'Sub-MS Latency Arbitrage',
    archetype: 'LATENCY_ARBITRAGE' as StrategyArchetype,
    assetClass: 'FX' as AssetClass,
    symbol: 'EUR/USD',
    opsPerSec: 320,
    maxDailyLoss: 10000,
    slippageLimitBps: 0.8,
    leverage: 20,
    winRate: 79.5,
  },
  {
    name: 'Momentum Flow Scalper',
    archetype: 'MOMENTUM_SCALPING' as StrategyArchetype,
    assetClass: 'COMMODITIES' as AssetClass,
    symbol: 'XAU/USD (Gold)',
    opsPerSec: 110,
    maxDailyLoss: 4500,
    slippageLimitBps: 2.5,
    leverage: 12,
    winRate: 66.4,
  },
];

export const DeployBotModal: React.FC<DeployBotModalProps> = ({
  isOpen,
  onClose,
  onDeploy,
}) => {
  const [formData, setFormData] = useState({
    name: 'Avellaneda-Stoikov Delta Maker',
    archetype: 'MARKET_MAKING' as StrategyArchetype,
    assetClass: 'CRYPTO' as AssetClass,
    symbol: 'BTC/USDT',
    maxDailyLoss: 5000,
    slippageLimitBps: 2.0,
    leverage: 5,
    opsPerSec: 180,
  });

  if (!isOpen) return null;

  const handleApplyPreset = (p: (typeof PRESET_STRATEGIES)[0]) => {
    setFormData({
      name: p.name,
      archetype: p.archetype,
      assetClass: p.assetClass,
      symbol: p.symbol,
      maxDailyLoss: p.maxDailyLoss,
      slippageLimitBps: p.slippageLimitBps,
      leverage: p.leverage,
      opsPerSec: p.opsPerSec,
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newBot: TradingBot = {
      id: `bot-${Date.now().toString(36)}`,
      name: formData.name,
      archetype: formData.archetype,
      assetClass: formData.assetClass,
      symbol: formData.symbol,
      isRunning: true,
      winRate: 65 + Math.random() * 8,
      pnl: 0,
      tradesCount: 0,
      opsPerSec: formData.opsPerSec,
      maxDailyLoss: formData.maxDailyLoss,
      slippageLimitBps: formData.slippageLimitBps,
      leverage: formData.leverage,
      gamma: 0.1,
      kappa: 1.5,
    };
    onDeploy(newBot);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-6 max-w-lg w-full shadow-2xl">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-[#1E293B]">
          <div className="flex items-center space-x-2">
            <Bot className="w-5 h-5 text-cyan-400" />
            <h3 className="text-sm font-bold text-white font-mono uppercase tracking-wider">
              Deploy High-Frequency Trading Bot
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white font-mono">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* PRESET INSTITUTIONAL STRATEGIES */}
        <div className="mb-4">
          <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block mb-1.5">
            Institutional Strategy Presets
          </span>
          <div className="grid grid-cols-2 gap-1.5 max-h-28 overflow-y-auto pr-1">
            {PRESET_STRATEGIES.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => handleApplyPreset(p)}
                className="p-1.5 rounded bg-[#141B2D] hover:bg-[#1E293B] border border-[#1E293B] text-[10px] font-mono text-left transition truncate"
              >
                <div className="text-cyan-400 font-bold truncate">{p.name}</div>
                <div className="text-slate-500 text-[9px] truncate">
                  {p.archetype.replace('_', ' ')} • {p.symbol}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* CUSTOM DEPLOY FORM */}
        <form onSubmit={handleSubmit} className="space-y-3 font-mono text-xs">
          <div>
            <label className="block text-slate-400 mb-1">Algorithm Name</label>
            <input
              type="text"
              required
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none focus:border-cyan-400"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 mb-1">Archetype</label>
              <select
                value={formData.archetype}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    archetype: e.target.value as StrategyArchetype,
                  })
                }
                className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none"
              >
                <option value="MARKET_MAKING">Market Making</option>
                <option value="STATISTICAL_ARBITRAGE">Statistical Arbitrage</option>
                <option value="ORDER_BOOK_IMBALANCE">Order Book Imbalance</option>
                <option value="LATENCY_ARBITRAGE">Latency Arbitrage</option>
                <option value="MOMENTUM_SCALPING">Momentum Scalping</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Asset Class</label>
              <select
                value={formData.assetClass}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    assetClass: e.target.value as AssetClass,
                  })
                }
                className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none"
              >
                <option value="CRYPTO">Crypto</option>
                <option value="EQUITIES">Equities</option>
                <option value="FX">FX</option>
                <option value="COMMODITIES">Commodities</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 mb-1">Target Pair / Symbol</label>
              <input
                type="text"
                required
                value={formData.symbol}
                onChange={(e) => setFormData({ ...formData, symbol: e.target.value })}
                className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Max Daily Loss ($)</label>
              <input
                type="number"
                min="500"
                value={formData.maxDailyLoss}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    maxDailyLoss: Number(e.target.value),
                  })
                }
                className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 mb-1">Slippage Limit (bps)</label>
              <input
                type="number"
                step="0.1"
                min="0.2"
                value={formData.slippageLimitBps}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    slippageLimitBps: Number(e.target.value),
                  })
                }
                className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Leverage Multiplier</label>
              <input
                type="number"
                min="1"
                max="50"
                value={formData.leverage}
                onChange={(e) =>
                  setFormData({ ...formData, leverage: Number(e.target.value) })
                }
                className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none"
              />
            </div>
          </div>

          <div className="flex items-center justify-end space-x-3 pt-4 border-t border-[#1E293B]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded bg-[#141B2D] text-slate-400 hover:text-white border border-[#1E293B]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-bold flex items-center space-x-1.5 shadow-lg shadow-cyan-500/20"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Deploy to CME / NY4 Engine</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
