import React, { useState } from 'react';
import { Bot, Play, Pause, Trash2, Settings, Zap, ShieldAlert } from 'lucide-react';
import { TradingBot } from '../types';

interface StrategyFleetProps {
  bots: TradingBot[];
  onToggleBot: (id: string) => void;
  onDeleteBot: (id: string) => void;
  onUpdateBot: (bot: TradingBot) => void;
  onOpenDeployModal: () => void;
}

export const StrategyFleet: React.FC<StrategyFleetProps> = ({
  bots,
  onToggleBot,
  onDeleteBot,
  onUpdateBot,
  onOpenDeployModal,
}) => {
  const [editingBot, setEditingBot] = useState<TradingBot | null>(null);

  const activeCount = bots.filter((b) => b.isRunning).length;

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingBot) {
      onUpdateBot(editingBot);
      setEditingBot(null);
    }
  };

  return (
    <div
      id="strategy-fleet-manager"
      className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-4 shadow-xl flex flex-col h-full"
    >
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#1E293B]">
        <div className="flex items-center space-x-2">
          <Bot className="w-3.5 h-3.5 text-cyan-400" />
          <h3 className="text-xs font-bold text-white uppercase font-mono tracking-wider">
            Algorithmic Strategy Fleet
          </h3>
          <span className="text-[10px] px-2 py-0.5 rounded bg-[#141B2D] text-cyan-300 font-mono">
            {activeCount} / {bots.length} Active
          </span>
        </div>

        <button
          onClick={onOpenDeployModal}
          className="text-[10px] font-mono font-semibold text-cyan-400 hover:text-cyan-300 transition"
        >
          + Add New
        </button>
      </div>

      {/* STRATEGY LIST */}
      <div className="space-y-2.5 overflow-y-auto max-h-[380px] pr-1">
        {bots.map((bot) => {
          const isPos = bot.pnl >= 0;
          return (
            <div
              key={bot.id}
              className={`p-3 rounded-lg border transition-all duration-200 relative ${
                bot.isRunning
                  ? 'bg-[#141B2D] border-[#1E293B] shadow-md'
                  : 'bg-[#0A0E17]/60 border-[#1E293B]/40 opacity-60'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center space-x-2 truncate">
                  <span
                    className={`h-2 w-2 rounded-full flex-shrink-0 ${
                      bot.isRunning ? 'bg-[#00E676] animate-pulse' : 'bg-slate-600'
                    }`}
                  />
                  <span className="font-bold text-white text-xs font-mono truncate">
                    {bot.name}
                  </span>
                </div>

                <div className="flex items-center space-x-1.5 flex-shrink-0">
                  <button
                    onClick={() => setEditingBot({ ...bot })}
                    title="Configure Strategy Limits"
                    className="p-1 rounded text-slate-400 hover:text-white bg-[#0D131F] hover:bg-[#1E293B] border border-[#1E293B] transition"
                  >
                    <Settings className="w-3 h-3" />
                  </button>

                  <button
                    onClick={() => onToggleBot(bot.id)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border transition flex items-center space-x-1 ${
                      bot.isRunning
                        ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
                        : 'bg-[#00E676]/10 border-[#00E676]/30 text-[#00E676] hover:bg-[#00E676]/20'
                    }`}
                  >
                    {bot.isRunning ? (
                      <>
                        <Pause className="w-2.5 h-2.5" />
                        <span>PAUSE</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-2.5 h-2.5" />
                        <span>RUN</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* DETAILS & BADGES */}
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-1.5">
                <div className="flex items-center space-x-2">
                  <span className="px-1.5 py-0.2 rounded bg-[#0D131F] text-cyan-400 border border-[#1E293B] text-[9px] font-bold">
                    {bot.assetClass}
                  </span>
                  <span className="text-[10px] text-slate-300 font-medium">
                    {bot.symbol}
                  </span>
                  <span className="text-[10px] text-slate-500 hidden sm:inline">
                    {bot.archetype.replace('_', ' ')}
                  </span>
                </div>

                <div
                  className={`font-mono font-bold text-xs ${
                    isPos ? 'text-[#00E676]' : 'text-red-400'
                  }`}
                >
                  {isPos ? '+' : ''}${bot.pnl.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </div>
              </div>

              {/* TELEMETRY FOOTER */}
              <div className="grid grid-cols-4 gap-1 pt-1.5 border-t border-[#1E293B]/60 text-[10px] font-mono text-slate-500">
                <div>
                  Win: <strong className="text-slate-300">{bot.winRate.toFixed(1)}%</strong>
                </div>
                <div>
                  Trades: <strong className="text-slate-300">{bot.tradesCount}</strong>
                </div>
                <div className="flex items-center space-x-0.5">
                  <Zap className="w-2.5 h-2.5 text-amber-400 inline" />
                  <span className="text-slate-300">{bot.opsPerSec} ops</span>
                </div>
                <div className="text-right">
                  Slip: <strong className="text-cyan-400">{bot.slippageLimitBps} bps</strong>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* QUICK EDIT MODAL */}
      {editingBot && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-5 max-w-md w-full shadow-2xl">
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-[#1E293B]">
              <div className="flex items-center space-x-2">
                <Settings className="w-4 h-4 text-cyan-400" />
                <h4 className="text-sm font-bold text-white font-mono uppercase">
                  Configure: {editingBot.name}
                </h4>
              </div>
              <button
                onClick={() => setEditingBot(null)}
                className="text-slate-400 hover:text-white font-mono text-xs"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-3 font-mono text-xs">
              <div>
                <label className="block text-slate-400 mb-1">Strategy Name</label>
                <input
                  type="text"
                  value={editingBot.name}
                  onChange={(e) =>
                    setEditingBot({ ...editingBot, name: e.target.value })
                  }
                  className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none focus:border-cyan-400"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Max Daily Loss ($)</label>
                  <input
                    type="number"
                    value={editingBot.maxDailyLoss}
                    onChange={(e) =>
                      setEditingBot({
                        ...editingBot,
                        maxDailyLoss: Number(e.target.value),
                      })
                    }
                    className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none focus:border-cyan-400"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Slippage Limit (bps)</label>
                  <input
                    type="number"
                    value={editingBot.slippageLimitBps}
                    onChange={(e) =>
                      setEditingBot({
                        ...editingBot,
                        slippageLimitBps: Number(e.target.value),
                      })
                    }
                    className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none focus:border-cyan-400"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Leverage Multiplier</label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={editingBot.leverage}
                    onChange={(e) =>
                      setEditingBot({
                        ...editingBot,
                        leverage: Number(e.target.value),
                      })
                    }
                    className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none focus:border-cyan-400"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Target Ops/Sec</label>
                  <input
                    type="number"
                    value={editingBot.opsPerSec}
                    onChange={(e) =>
                      setEditingBot({
                        ...editingBot,
                        opsPerSec: Number(e.target.value),
                      })
                    }
                    className="w-full bg-[#141B2D] border border-[#1E293B] rounded px-3 py-1.5 text-white outline-none focus:border-cyan-400"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-[#1E293B]">
                <button
                  type="button"
                  onClick={() => {
                    onDeleteBot(editingBot.id);
                    setEditingBot(null);
                  }}
                  className="px-3 py-1.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30 flex items-center space-x-1"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Decommission</span>
                </button>

                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setEditingBot(null)}
                    className="px-3 py-1.5 rounded bg-[#141B2D] text-slate-400 hover:text-white border border-[#1E293B]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-bold"
                  >
                    Save Changes
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
