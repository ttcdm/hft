import React, { useState } from 'react';
import { useEscapeToClose } from '../utils/useEscapeToClose';
import { Sparkles, Brain, Search, Send, X, ShieldAlert, Cpu } from 'lucide-react';
import { authFetch } from '../services/engineClient';
import { DialogFrame } from './DialogFrame';

interface AiDiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DIAGNOSTICS_DEFAULT_PROMPT = 'Review this state and point out anything that needs attention before I leave the auto trader running.';

/**
 * Quant AI Diagnostics. It does not read the screen: the server builds the state it sends (system checks, auto journal stats, measured
 * latency), and the answer shows exactly that state next to it. The Google Search mode sends only the question, no workstation state.
 */
export const AiDiagnosticsModal: React.FC<AiDiagnosticsModalProps> = ({ isOpen, onClose }) => {
  const [mode, setMode] = useState<'thinking' | 'search'>('thinking');
  const [prompt, setPrompt] = useState(DIAGNOSTICS_DEFAULT_PROMPT);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEscapeToClose(isOpen, onClose);
  if (!isOpen) return null;

  const handleRunAnalysis = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await authFetch('/api/ai/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, prompt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || `Diagnostic request failed (HTTP ${res.status}).`); // no canned analysis when the model is unavailable
      else setResult(data);
    } catch (e: any) {
      setError(e.message || 'Failed to reach the server.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DialogFrame label="AI diagnostics" className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-6 max-w-2xl w-full shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <div>
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">Quant AI Diagnostics</h3>
              <p className="text-[10px] text-slate-400" data-testid="ai-reads-note">
                Reads the server's live state (system checks, auto journal stats, measured latency) and sends it to Google Gemini when you press Run. Needs GEMINI_API_KEY in .env. Advice only: it cannot trade.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4 text-xs">
          <button type="button" onClick={() => { setMode('thinking'); setPrompt(DIAGNOSTICS_DEFAULT_PROMPT); }}
            className={`p-2.5 rounded-lg border text-left flex items-start space-x-2 ${mode === 'thinking' ? 'bg-cyan-500/15 border-cyan-500 text-white' : 'bg-[#141B2D] border-[#1E293B] text-slate-400 hover:text-white'}`}>
            <Brain className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-[11px] text-cyan-300">Review this workstation</div>
              <div className="text-[10px] text-slate-400">gemini-3.1-pro-preview · sends the state below</div>
            </div>
          </button>
          <button type="button" onClick={() => { setMode('search'); setPrompt('What is happening with pump.fun launch activity on Solana right now?'); }}
            className={`p-2.5 rounded-lg border text-left flex items-start space-x-2 ${mode === 'search' ? 'bg-blue-500/15 border-blue-500 text-white' : 'bg-[#141B2D] border-[#1E293B] text-slate-400 hover:text-white'}`}>
            <Search className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-[11px] text-blue-300">Web search question</div>
              <div className="text-[10px] text-slate-400">gemini-3.5-flash · Google Search · sends only your question</div>
            </div>
          </button>
        </div>

        <label className="block text-slate-400 text-[11px] mb-1">Question:</label>
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)}
          className="bg-[#141B2D] border border-[#1E293B] rounded-lg p-2.5 text-xs text-white outline-none focus:border-cyan-400 resize-none mb-2" />
        <div className="flex justify-end mb-3">
          <button onClick={handleRunAnalysis} disabled={loading}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 text-white font-bold text-xs flex items-center space-x-1.5 disabled:opacity-50">
            <Send className="w-3.5 h-3.5" /><span>{loading ? 'Reasoning...' : 'Run'}</span>
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/50 text-red-300 text-xs mb-3 flex items-center space-x-2" data-testid="ai-error">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" /><span>{error}</span>
          </div>
        )}

        {result && (
          <div className="flex-1 overflow-y-auto bg-[#06080D] border border-[#1E293B] rounded-lg p-4 text-xs text-slate-300 space-y-3">
            <div className="flex items-center text-[10px] text-cyan-400 pb-2 border-b border-[#1E293B]"><Cpu className="w-3 h-3 mr-1" />Model: {result.model}</div>
            <div className="whitespace-pre-wrap leading-relaxed text-slate-200">{result.analysis}</div>
            {result.context && (
              <details className="text-[10px] text-slate-500" data-testid="ai-context">
                <summary className="cursor-pointer">State that was sent</summary>
                <pre className="whitespace-pre-wrap">{JSON.stringify(result.context, null, 2)}</pre>
              </details>
            )}
            {result.groundingMetadata?.webSearchQueries && (
              <div className="pt-2 border-t border-[#1E293B] text-[10px] text-slate-500">Search queries: <span className="text-cyan-400">{result.groundingMetadata.webSearchQueries.join(' • ')}</span></div>
            )}
          </div>
        )}
      </div>
    </DialogFrame>
  );
};
