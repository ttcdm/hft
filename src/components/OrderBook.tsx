import React from 'react';
import { Layers, ArrowUpRight, ArrowDownRight, Compass } from 'lucide-react';
import { OrderBook as OrderBookType, OrderSide } from '../types';

interface OrderBookProps {
  orderBook: OrderBookType;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  lastTradedSide?: OrderSide;
  flashTrigger: number;
}

export const OrderBook: React.FC<OrderBookProps> = ({
  orderBook,
  selectedSymbol,
  onSelectSymbol,
  lastTradedSide,
  flashTrigger,
}) => {
  const { asks, bids, midPrice, spread, microPrice, imbalanceRatio } = orderBook;
  const spreadBps = midPrice > 0 ? ((spread / midPrice) * 10000).toFixed(1) : '0.0';

  // OFI gauge representation
  const ofiBuyPct = Math.round(((imbalanceRatio + 1) / 2) * 100);
  const ofiSellPct = 100 - ofiBuyPct;

  return (
    <div
      id="level-2-order-depth"
      className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-4 shadow-xl flex flex-col h-full"
    >
      {/* HEADER & PAIR SELECTOR */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#1E293B]">
        <div className="flex items-center space-x-2">
          <Layers className="w-3.5 h-3.5 text-cyan-400" />
          <h3 className="text-xs font-bold text-white uppercase font-mono tracking-wider">
            L2 Depth Ladder
          </h3>
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-[#00E676] border border-emerald-500/30 font-mono">
            LIVE 100ms
          </span>
        </div>

        <div className="flex items-center space-x-1">
          {['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT', 'XRP/USDT'].map((sym) => (
            <button
              key={sym}
              onClick={() => onSelectSymbol(sym)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono transition ${
                selectedSymbol === sym
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                  : 'text-slate-400 hover:text-white bg-[#141B2D]'
              }`}
            >
              {sym.split('/')[0]}
            </button>
          ))}
        </div>
      </div>

      {/* OFI IMBALANCE INDICATOR BAR */}
      <div className="mb-2 p-2 rounded-lg bg-[#06080D] border border-[#1E293B] text-[11px] font-mono">
        <div className="flex items-center justify-between mb-1">
          <span className="text-slate-400 text-[10px] uppercase flex items-center space-x-1">
            <Compass className="w-3 h-3 text-cyan-400 mr-1" />
            Order Flow Imbalance (OFI)
          </span>
          <span
            className={`font-bold text-[10px] ${
              imbalanceRatio > 0.05
                ? 'text-[#00E676]'
                : imbalanceRatio < -0.05
                ? 'text-red-400'
                : 'text-slate-300'
            }`}
          >
            {imbalanceRatio > 0 ? '+' : ''}
            {(imbalanceRatio * 100).toFixed(1)}% ({imbalanceRatio > 0 ? 'BUY SKEW' : 'SELL SKEW'})
          </span>
        </div>

        {/* Visual Dual-Bar */}
        <div className="h-1.5 w-full bg-[#1E293B] rounded-full overflow-hidden flex">
          <div
            style={{ width: `${ofiBuyPct}%` }}
            className="h-full bg-gradient-to-r from-emerald-600 to-[#00E676] transition-all duration-300"
          />
          <div
            style={{ width: `${ofiSellPct}%` }}
            className="h-full bg-gradient-to-r from-red-500 to-rose-700 transition-all duration-300"
          />
        </div>
      </div>

      {/* TABLE COLUMN LABELS */}
      <div className="grid grid-cols-3 text-[10px] font-mono text-slate-500 pb-1 mb-1 px-1">
        <span>PRICE (USD)</span>
        <span className="text-right">SIZE</span>
        <span className="text-right">CUMULATIVE</span>
      </div>

      {/* ASKS (RED) - Highest to Lowest */}
      <div className="space-y-[2px] font-mono text-xs flex-1">
        {asks.slice(0, 6).map((ask, idx) => (
          <div
            key={`ask-${idx}`}
            className="grid grid-cols-3 text-red-400 px-1 py-0.5 relative rounded hover:bg-red-500/10 transition"
          >
            {/* Depth Fill Bar */}
            <div
              className="absolute right-0 top-0 bottom-0 bg-red-500/10 rounded-r pointer-events-none transition-all duration-200"
              style={{ width: `${Math.min(100, ask.depthPct)}%` }}
            />
            <span className="font-semibold z-10">{ask.price.toFixed(2)}</span>
            <span className="text-right text-slate-300 z-10">{ask.size.toFixed(3)}</span>
            <span className="text-right text-slate-500 z-10">{ask.total.toFixed(3)}</span>
          </div>
        ))}
      </div>

      {/* SPREAD & MICRO-PRICE DIVIDER */}
      <div
        id="orderbook-spread-divider"
        className={`py-1.5 px-3 my-1 rounded bg-[#141B2D] border border-[#1E293B] flex items-center justify-between text-xs font-mono transition-all duration-300 ${
          lastTradedSide === 'BUY'
            ? 'ring-1 ring-[#00E676] bg-[#00E676]/10'
            : lastTradedSide === 'SELL'
            ? 'ring-1 ring-red-500 bg-red-500/10'
            : ''
        }`}
      >
        <div className="flex items-center space-x-2">
          <span
            className={`font-black text-sm tracking-tight ${
              lastTradedSide === 'BUY'
                ? 'text-[#00E676]'
                : lastTradedSide === 'SELL'
                ? 'text-red-400'
                : 'text-white'
            }`}
          >
            {midPrice.toFixed(2)}
          </span>
          {lastTradedSide === 'BUY' ? (
            <ArrowUpRight className="w-3.5 h-3.5 text-[#00E676]" />
          ) : (
            <ArrowDownRight className="w-3.5 h-3.5 text-red-400" />
          )}
        </div>

        <div className="text-[10px] text-slate-400 flex items-center space-x-3">
          <span>
            Spread: <strong className="text-white">${spread.toFixed(2)}</strong> <span className="text-slate-500 font-mono">({spreadBps} bps)</span>
          </span>
          <span className="text-cyan-400">
            Micro: <strong>${microPrice.toFixed(2)}</strong>
          </span>
        </div>
      </div>

      {/* BIDS (GREEN) - Highest to Lowest */}
      <div className="space-y-[2px] font-mono text-xs flex-1">
        {bids.slice(0, 6).map((bid, idx) => (
          <div
            key={`bid-${idx}`}
            className="grid grid-cols-3 text-[#00E676] px-1 py-0.5 relative rounded hover:bg-emerald-500/10 transition"
          >
            {/* Depth Fill Bar */}
            <div
              className="absolute right-0 top-0 bottom-0 bg-[#00E676]/10 rounded-r pointer-events-none transition-all duration-200"
              style={{ width: `${Math.min(100, bid.depthPct)}%` }}
            />
            <span className="font-semibold z-10">{bid.price.toFixed(2)}</span>
            <span className="text-right text-slate-300 z-10">{bid.size.toFixed(3)}</span>
            <span className="text-right text-slate-500 z-10">{bid.total.toFixed(3)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
