import React, { useState } from 'react';
import { Sparkles, Brain, Search, Send, X, ShieldAlert, Cpu } from 'lucide-react';
import { TradingBot, PerformanceKPIs, NetworkStressConfig } from '../types';

interface AiDiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  bots: TradingBot[];
  kpis: PerformanceKPIs;
  stressConfig: NetworkStressConfig;
}

export const AiDiagnosticsModal: React.FC<AiDiagnosticsModalProps> = ({
  isOpen,
  onClose,
  bots,
  kpis,
  stressConfig,
}) => {
  const [mode, setMode] = useState<'thinking' | 'search'>('thinking');
  const [prompt, setPrompt] = useState(
    'Audit our active market making gamma parameters and evaluate whether our slippage bounds will withstand a 15ms packet jitter event.'
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleRunAnalysis = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/ai/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          strategyConfig: bots.map((b) => ({
            name: b.name,
            archetype: b.archetype,
            symbol: b.symbol,
            opsPerSec: b.opsPerSec,
            slippageLimitBps: b.slippageLimitBps,
            maxDailyLoss: b.maxDailyLoss,
            leverage: b.leverage,
          })),
          telemetry: {
            dailyPnL: kpis.dailyPnL,
            sharpeRatio: kpis.sharpeRatio,
            sortinoRatio: kpis.sortinoRatio,
            winRate: kpis.winRate,
            maxDrawdown: kpis.maxDrawdownPct,
            avgLatencyMs: kpis.averageLatencyMs,
            stressActive: stressConfig.isStressActive,
            stressProfile: stressConfig.profile,
          },
          prompt,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.offlineAnalysis) {
          setResult({
            analysis: `[Offline Diagnostic Engine]: ${data.offlineAnalysis.recommendation}\n\nEstimated Sharpe: ${data.offlineAnalysis.estimatedSharpe}\nRisk Assessment: ${data.offlineAnalysis.riskScore}\n\n(Note: Configure GEMINI_API_KEY in AI Studio Settings to activate full Deep Thinking Mode with gemini-3.1-pro-preview)`,
          });
        } else {
          setError(data.error || 'Diagnostic request failed.');
        }
      } else {
        setResult(data);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to connect to AI Diagnostics engine.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-6 max-w-2xl w-full shadow-2xl flex flex-col max-h-[90vh]">
        {/* HEADER */}
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-[#1E293B]">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-5 h-5 text-cyan-400 animate-pulse" />
            <div>
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                Apex Quant AI — Institutional Strategy Diagnostics
              </h3>
              <p className="text-[10px] text-slate-400">
                Powered by Gemini 3.1 Pro (High Thinking) & Gemini 3.5 Flash (Search Grounding)
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* MODE SELECTOR */}
        <div className="grid grid-cols-2 gap-2 mb-4 text-xs">
          <button
            type="button"
            onClick={() => {
              setMode('thinking');
              setPrompt(
                'Audit our active market making gamma parameters and evaluate whether our slippage bounds will withstand a 15ms packet jitter event.'
              );
            }}
            className={`p-2.5 rounded-lg border text-left flex items-start space-x-2 transition ${
              mode === 'thinking'
                ? 'bg-cyan-500/15 border-cyan-500 text-white shadow-md shadow-cyan-500/10'
                : 'bg-[#141B2D] border-[#1E293B] text-slate-400 hover:text-white'
            }`}
          >
            <Brain className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-[11px] text-cyan-300">
                Deep Quant Thinking Mode
              </div>
              <div className="text-[10px] text-slate-400">
                gemini-3.1-pro-preview • High Thinking Level
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setMode('search');
              setPrompt(
                'What are the real-time macroeconomic announcements, CPI, and Fed liquidity conditions driving crypto and equity volatility right now?'
              );
            }}
            className={`p-2.5 rounded-lg border text-left flex items-start space-x-2 transition ${
              mode === 'search'
                ? 'bg-blue-500/15 border-blue-500 text-white shadow-md shadow-blue-500/10'
                : 'bg-[#141B2D] border-[#1E293B] text-slate-400 hover:text-white'
            }`}
          >
            <Search className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-[11px] text-blue-300">
                Market Grounding Engine
              </div>
              <div className="text-[10px] text-slate-400">
                gemini-3.5-flash • Live Google Search Data
              </div>
            </div>
          </button>
        </div>

        {/* PROMPT INPUT */}
        <div className="mb-4">
          <label className="block text-slate-400 text-[11px] mb-1">
            Quant Prompt / Diagnostic Query:
          </label>
          <div className="flex space-x-2">
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="flex-1 bg-[#141B2D] border border-[#1E293B] rounded-lg p-2.5 text-xs text-white outline-none focus:border-cyan-400 resize-none"
            />
          </div>
          <div className="flex justify-between items-center mt-2">
            <span className="text-[10px] text-slate-500">
              Passes active strategy parameters, drawdown history, and network jitter metrics
            </span>
            <button
              onClick={handleRunAnalysis}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-bold text-xs flex items-center space-x-1.5 shadow-lg shadow-cyan-500/20 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span>Reasoning...</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Execute Diagnostic</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* ERROR NOTICE */}
        {error && (
          <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/50 text-red-300 text-xs mb-4 flex items-center space-x-2">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* RESULTS OUTPUT */}
        {result && (
          <div className="flex-1 overflow-y-auto bg-[#06080D] border border-[#1E293B] rounded-lg p-4 text-xs font-mono text-slate-300 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[#1E293B] text-[10px] text-cyan-400">
              <span className="flex items-center space-x-1">
                <Cpu className="w-3 h-3 mr-1" />
                Model: {result.model} {result.thinkingEnabled ? '(Thinking Level: HIGH)' : ''}
              </span>
              <span className="text-slate-500">Analysis Completed</span>
            </div>

            <div className="whitespace-pre-wrap leading-relaxed text-slate-200">
              {result.analysis}
            </div>

            {result.groundingMetadata?.webSearchQueries && (
              <div className="pt-2 border-t border-[#1E293B] text-[10px] text-slate-500">
                <div>Search Queries Grounded:</div>
                <div className="text-cyan-400">
                  {result.groundingMetadata.webSearchQueries.join(' • ')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* FOOTER */}
        <div className="pt-3 mt-4 border-t border-[#1E293B] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-[#141B2D] text-slate-300 hover:text-white border border-[#1E293B] text-xs"
          >
            Close Diagnostics
          </button>
        </div>
      </div>
    </div>
  );
};
