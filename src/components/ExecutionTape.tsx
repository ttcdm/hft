import React, { useState } from 'react';
import { Terminal, Download, Radio, Activity, Filter } from 'lucide-react';
import { ExecutedTrade, PublicMarketTrade, OrderSide } from '../types';

interface ExecutionTapeProps {
  trades: ExecutedTrade[];
  publicTrades: PublicMarketTrade[];
  onExportPackets: () => void;
  selectedSymbol: string;
}

export const ExecutionTape: React.FC<ExecutionTapeProps> = ({
  trades,
  publicTrades,
  onExportPackets,
  selectedSymbol,
}) => {
  const [feedMode, setFeedMode] = useState<'PUBLIC_TAPE' | 'BOT_BLOTTER'>('PUBLIC_TAPE');
  const [sideFilter, setSideFilter] = useState<'ALL' | OrderSide>('ALL');

  const filteredPublicTrades = publicTrades.filter((t) => {
    if (sideFilter !== 'ALL' && t.side !== sideFilter) return false;
    return true;
  });

  const filteredBotTrades = trades.filter((t) => {
    if (sideFilter !== 'ALL' && t.side !== sideFilter) return false;
    return true;
  });

  const exportCSV = () => {
    if (feedMode === 'PUBLIC_TAPE') {
      const headers = 'TradeID,Timestamp,Symbol,Side,Price,Size,NotionalUsd,AggressiveTaker\n';
      const rows = filteredPublicTrades
        .map(
          (t) =>
            `${t.id},${t.microsecondTime},${t.symbol},${t.side},${t.price},${t.size},${t.notionalUsd},${
              t.isBuyerMaker ? 'SELLER_TAKER' : 'BUYER_TAKER'
            }`
        )
        .join('\n');
      const blob = new Blob([headers + rows], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `binance_real_tape_${selectedSymbol.replace('/', '_')}_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const headers = 'ID,MicrosecondTime,BotName,Symbol,Side,Status,Price,Size,PnLDelta,SlippageBps,LatencyMs\n';
      const rows = filteredBotTrades
        .map(
          (t) =>
            `${t.id},${t.microsecondTime},"${t.botName}",${t.symbol},${t.side},${t.status},${t.price},${t.size},${t.pnlDelta},${t.slippageBps},${t.executionLatencyMs}`
        )
        .join('\n');
      const blob = new Blob([headers + rows], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `apex_quant_blotter_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div
      id="execution-tape-blotter"
      className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-4 shadow-xl flex flex-col h-full"
    >
      {/* HEADER & CONTROLS */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#1E293B] flex-wrap gap-2">
        <div className="flex items-center space-x-2">
          <Terminal className="w-3.5 h-3.5 text-cyan-400" />
          <h3 className="text-xs font-bold text-white uppercase font-mono tracking-wider">
            {feedMode === 'PUBLIC_TAPE' ? 'Real Exchange Tape' : 'Quant Execution Blotter'}
          </h3>
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-[#00E676] border border-emerald-500/30 font-mono font-bold flex items-center space-x-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[#00E676] animate-ping inline-block" />
            <span>DIRECT DMA FLOW</span>
          </span>
        </div>

        {/* FEED MODE TOGGLE & FILTERS */}
        <div className="flex items-center space-x-2">
          {/* Mode switch */}
          <div className="flex rounded bg-[#141B2D] border border-[#1E293B] p-0.5 text-[10px] font-mono">
            <button
              onClick={() => setFeedMode('PUBLIC_TAPE')}
              className={`px-2 py-0.5 rounded transition ${
                feedMode === 'PUBLIC_TAPE'
                  ? 'bg-cyan-500/20 text-cyan-300 font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Public Exchange Tape
            </button>
            <button
              onClick={() => setFeedMode('BOT_BLOTTER')}
              className={`px-2 py-0.5 rounded transition ${
                feedMode === 'BOT_BLOTTER'
                  ? 'bg-cyan-500/20 text-cyan-300 font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Quant Blotter ({trades.length})
            </button>
          </div>

          {/* Side Filter */}
          <select
            value={sideFilter}
            onChange={(e) => setSideFilter(e.target.value as any)}
            className="bg-[#141B2D] border border-[#1E293B] rounded px-2 py-0.5 text-[10px] font-mono text-slate-300 outline-none cursor-pointer"
          >
            <option value="ALL">Side: ALL</option>
            <option value="BUY">BUY Only</option>
            <option value="SELL">SELL Only</option>
          </select>

          {/* Export CSV */}
          <button
            onClick={exportCSV}
            title="Export Tape to CSV"
            className="p-1 px-2 rounded bg-[#141B2D] hover:bg-[#1E293B] border border-[#1E293B] text-[10px] font-mono text-slate-300 flex items-center space-x-1"
          >
            <Download className="w-3 h-3" />
            <span className="hidden sm:inline">CSV</span>
          </button>

          {/* Export PCAP */}
          <button
            onClick={onExportPackets}
            title="Export Raw Packet PCAP Logs"
            className="p-1 px-2 rounded bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-[10px] font-mono text-cyan-300 flex items-center space-x-1"
          >
            <Download className="w-3 h-3 text-cyan-400" />
            <span className="hidden sm:inline">PCAP</span>
          </button>
        </div>
      </div>

      {feedMode === 'PUBLIC_TAPE' ? (
        /* REAL PUBLIC EXCHANGE TAPE VIEW */
        <div className="flex flex-col flex-1 min-h-0 font-mono">
          {/* COLUMN HEADERS */}
          <div className="grid grid-cols-12 text-[10px] text-slate-500 pb-1 mb-1 px-1 border-b border-[#1E293B]/60">
            <span className="col-span-3 sm:col-span-2">TIMESTAMP</span>
            <span className="col-span-2 sm:col-span-2">SIDE / TYPE</span>
            <span className="col-span-3 sm:col-span-3 text-right">PRICE (USD)</span>
            <span className="col-span-2 sm:col-span-2 text-right">SIZE</span>
            <span className="col-span-2 sm:col-span-3 text-right">NOTIONAL</span>
          </div>

          {/* PUBLIC TRADE TICKS */}
          <div className="space-y-[2px] overflow-y-auto max-h-[360px] pr-1 text-xs flex-1">
            {filteredPublicTrades.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-[11px]">
                Connecting to live trade stream...
              </div>
            ) : (
              filteredPublicTrades.slice(0, 60).map((t) => {
                const isBuy = t.side === 'BUY';
                return (
                  <div
                    key={`pub-${t.id}`}
                    className="grid grid-cols-12 py-0.5 px-1 rounded text-[11px] items-center hover:bg-[#141B2D]/60 transition"
                  >
                    {/* Timestamp */}
                    <span className="col-span-3 sm:col-span-2 text-slate-400 text-[10px] truncate">
                      {t.microsecondTime.split(' ')[0] || t.timeStr}
                    </span>

                    {/* Side & Taker Tag */}
                    <div className="col-span-2 sm:col-span-2 flex items-center space-x-1 truncate">
                      <span
                        className={`font-black text-[10px] px-1 rounded ${
                          isBuy
                            ? 'text-[#00E676] bg-[#00E676]/10'
                            : 'text-red-400 bg-red-500/10'
                        }`}
                      >
                        {isBuy ? 'TAKER BUY' : 'TAKER SELL'}
                      </span>
                    </div>

                    {/* Executed Price */}
                    <span
                      className={`col-span-3 sm:col-span-3 text-right font-bold ${
                        isBuy ? 'text-[#00E676]' : 'text-red-400'
                      }`}
                    >
                      ${t.price.toFixed(2)}
                    </span>

                    {/* Quantity */}
                    <span className="col-span-2 sm:col-span-2 text-right text-slate-300 text-[10px]">
                      {t.size >= 1 ? t.size.toFixed(2) : t.size.toFixed(4)}
                    </span>

                    {/* Notional Value */}
                    <span className="col-span-2 sm:col-span-3 text-right text-slate-400 text-[10px]">
                      ${t.notionalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : (
        /* QUANT FLEET BLOTTER VIEW */
        <div className="flex flex-col flex-1 min-h-0 font-mono">
          {/* COLUMN HEADERS */}
          <div className="grid grid-cols-12 text-[10px] text-slate-500 pb-1 mb-1 px-1 border-b border-[#1E293B]/60">
            <span className="col-span-3 sm:col-span-2">TIMESTAMP</span>
            <span className="col-span-2 sm:col-span-2">BOT / SIDE</span>
            <span className="col-span-2 sm:col-span-2 text-right">PRICE</span>
            <span className="col-span-2 sm:col-span-2 text-right">SIZE</span>
            <span className="hidden sm:inline-block sm:col-span-2 text-right">SLIPPAGE</span>
            <span className="col-span-3 sm:col-span-2 text-right">P&L / STATUS</span>
          </div>

          {/* BOT TRADES */}
          <div className="space-y-1 overflow-y-auto max-h-[360px] pr-1 text-xs flex-1">
            {filteredBotTrades.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-[11px]">
                No bot fills recorded yet.
              </div>
            ) : (
              filteredBotTrades.slice(0, 50).map((t) => {
                const isBuy = t.side === 'BUY';
                const isRejected = t.status === 'REJECTED';
                return (
                  <div
                    key={`bot-${t.id}`}
                    className={`grid grid-cols-12 py-1 px-1 rounded transition-colors text-[11px] items-center ${
                      isRejected
                        ? 'bg-red-950/20 text-red-400 border border-red-900/30'
                        : 'hover:bg-[#141B2D]/60'
                    }`}
                  >
                    {/* Timestamp */}
                    <span className="col-span-3 sm:col-span-2 text-slate-400 text-[10px] truncate">
                      {t.microsecondTime.split(' ')[0] || t.microsecondTime}
                    </span>

                    {/* Bot & Side */}
                    <div className="col-span-2 sm:col-span-2 flex items-center space-x-1 truncate">
                      <span
                        className={`font-black text-[10px] px-1 rounded ${
                          isBuy
                            ? 'text-[#00E676] bg-[#00E676]/10'
                            : 'text-red-400 bg-red-500/10'
                        }`}
                      >
                        {t.side}
                      </span>
                      <span className="text-slate-300 text-[10px] truncate">
                        {t.botName.split(' ')[0]}
                      </span>
                    </div>

                    {/* Price */}
                    <span className="col-span-2 sm:col-span-2 text-right text-white font-semibold">
                      ${t.price.toFixed(2)}
                    </span>

                    {/* Size */}
                    <span className="col-span-2 sm:col-span-2 text-right text-slate-400 text-[10px]">
                      {t.size.toFixed(3)}
                    </span>

                    {/* Slippage & Latency */}
                    <div className="hidden sm:block sm:col-span-2 text-right text-[10px] text-slate-400">
                      <span
                        className={
                          t.slippageBps > 5
                            ? 'text-amber-400 font-bold'
                            : 'text-slate-300'
                        }
                      >
                        {t.slippageBps.toFixed(1)} bps
                      </span>
                      <span className="text-slate-600 ml-1">
                        ({t.executionLatencyMs.toFixed(1)}ms)
                      </span>
                    </div>

                    {/* PnL or Rejection */}
                    <div className="col-span-3 sm:col-span-2 text-right font-bold text-[11px]">
                      {isRejected ? (
                        <span className="text-red-400 text-[10px] bg-red-500/20 px-1 py-0.5 rounded">
                          REJ: {t.rejectionReason || 'DROP'}
                        </span>
                      ) : (
                        <span
                          className={
                            t.pnlDelta >= 0 ? 'text-[#00E676]' : 'text-red-400'
                          }
                        >
                          {t.pnlDelta >= 0 ? '+' : ''}${t.pnlDelta.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
