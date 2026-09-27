import React, { useState, useEffect } from 'react';
import { KeyRound, Lock, ShieldCheck, AlertCircle, Eye, EyeOff, X, Terminal, CheckCircle2 } from 'lucide-react';
import { setOperatorSessionToken, getOperatorSessionToken } from '../services/engineClient';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticated?: (token: string) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onAuthenticated,
}) => {
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [currentlyStored, setCurrentlyStored] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      const stored = typeof window !== 'undefined' ? localStorage.getItem('apex_operator_token') : null;
      if (stored) {
        setCurrentlyStored(stored);
        setTokenInput(stored);
      } else {
        setCurrentlyStored(null);
      }
      setErrorMessage(null);
      setSuccessMessage(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleValidateAndSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = tokenInput.trim();

    if (!token) {
      setErrorMessage('Please provide an operator authentication token.');
      return;
    }

    if (token.length < 16) {
      setErrorMessage('Token must be at least 16 characters long (standard 256-bit cryptographic token).');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      // Validate against authoritative /api/auth/session endpoint
      const res = await fetch('/api/auth/session', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-session-token': token,
        },
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        throw new Error(errorData?.error || `Authentication failed (HTTP ${res.status}): Invalid operator token.`);
      }

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Server rejected operator session credentials.');
      }

      // Store in localStorage and update engineClient cache
      if (typeof window !== 'undefined') {
        localStorage.setItem('apex_operator_token', token);
      }
      setOperatorSessionToken(token);
      setCurrentlyStored(token);
      setSuccessMessage('Operator session authenticated successfully.');

      if (onAuthenticated) {
        onAuthenticated(token);
      }

      setTimeout(() => {
        onClose();
      }, 750);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to authenticate operator token.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearToken = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('apex_operator_token');
    }
    setOperatorSessionToken('');
    setCurrentlyStored(null);
    setTokenInput('');
    setSuccessMessage(null);
    setErrorMessage('Stored token cleared. Operator session terminated.');
  };

  const handleAutoConnect = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch('/api/auth/session');
      const data = await res.json();
      if (res.ok && data.success && data.token) {
        setTokenInput(data.token);
        if (typeof window !== 'undefined') {
          localStorage.setItem('apex_operator_token', data.token);
        }
        setOperatorSessionToken(data.token);
        setCurrentlyStored(data.token);
        setSuccessMessage('Operator session auto-connected successfully.');
        if (onAuthenticated) onAuthenticated(data.token);
        setTimeout(() => onClose(), 600);
      } else {
        throw new Error(data.error || 'No auto-provisioned session available.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Auto-connect failed.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl max-w-lg w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#1E293B] flex items-center justify-between bg-[#101726]">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-white font-bold text-base flex items-center space-x-2">
                <span>Operator Authentication</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-cyan-300 font-mono">
                  SECURITY GATE
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Authorized session required for telemetry, mutations & live trading
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-[#1E293B] transition"
            title="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleValidateAndSubmit} className="p-6 space-y-4">
          {currentlyStored ? (
            <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/30 flex items-center justify-between text-xs">
              <div className="flex items-center space-x-2 text-emerald-400">
                <ShieldCheck className="w-4 h-4 flex-shrink-0" />
                <span>Active token configured in browser storage</span>
              </div>
              <button
                type="button"
                onClick={handleClearToken}
                className="text-[11px] px-2 py-0.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/30 transition"
              >
                Clear Token
              </button>
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-500/30 text-xs text-amber-300 flex items-start justify-between space-x-2">
              <div className="flex items-start space-x-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  No operator token configured in storage. Use Quick Connect to auto-authorize or enter token manually.
                </span>
              </div>
              <button
                type="button"
                onClick={handleAutoConnect}
                disabled={isLoading}
                className="px-2.5 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-300 font-bold text-[11px] whitespace-nowrap transition flex items-center space-x-1"
              >
                <span>⚡ Quick Connect</span>
              </button>
            </div>
          )}

          {errorMessage && (
            <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-xs text-red-300 flex items-start space-x-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-xs text-emerald-300 flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-400" />
              <span>{successMessage}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase tracking-wider">
              Operator Session Token
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                <Lock className="w-4 h-4" />
              </div>
              <input
                type={showToken ? 'text' : 'password'}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Enter OPERATOR_AUTH_TOKEN (min 16 chars)..."
                className="w-full bg-[#141B2D] border border-[#1E293B] rounded-lg pl-9 pr-10 py-2.5 text-sm text-white font-mono placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition"
                autoComplete="off"
                spellCheck="false"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-white"
                title={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#080D1A] border border-[#1E293B] text-[11px] text-slate-400 space-y-1.5">
            <div className="flex items-center space-x-1.5 text-slate-300 font-semibold">
              <Terminal className="w-3.5 h-3.5 text-cyan-400" />
              <span>Where do I find this token?</span>
            </div>
            <p>
              1. <strong>Configured in .env:</strong> If defined as <code className="text-cyan-300">OPERATOR_AUTH_TOKEN="your_token"</code>, paste that exact string here.
            </p>
            <p>
              2. <strong>Auto-generated volatile token:</strong> If unset in <code className="text-slate-300">.env</code>, check your Node.js server startup terminal. A highlighted banner displays the generated token.
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end space-x-3 pt-3 border-t border-[#1E293B]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-[#141B2D] text-slate-400 hover:text-white border border-[#1E293B] text-xs font-medium transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !tokenInput.trim()}
              className={`px-5 py-2 rounded-lg text-xs font-bold font-mono uppercase tracking-wider flex items-center space-x-2 transition shadow-lg ${
                isLoading || !tokenInput.trim()
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                  : 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white border border-cyan-400/30 shadow-cyan-500/20'
              }`}
            >
              {isLoading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Validating...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Authenticate Session</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
