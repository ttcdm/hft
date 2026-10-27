import React from 'react';
import { authFetch } from '../services/engineClient';

/**
 * R9-2: a render error in one panel used to unmount the whole app, header and KILL SWITCH included, until a reload.
 *
 * PanelErrorBoundary wraps each panel and modal: the panel that threw is replaced by a notice, everything else stays.
 * RootErrorBoundary wraps the app (src/main.tsx): if even the header throws, it shows a bare KILL SWITCH that still posts to the server.
 */
type BoundaryState = { error: Error | null };

export class PanelErrorBoundary extends React.Component<{ name: string; children?: React.ReactNode }, BoundaryState> {
  // the project has no @types/react, so the base class members are declared here
  declare props: { name: string; children?: React.ReactNode };
  declare setState: (s: Partial<BoundaryState>) => void;
  state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): BoundaryState { return { error }; }
  componentDidCatch(error: Error) { console.error(`[ui] ${this.props.name} failed to render:`, error); }
  render() {
    if (!this.state.error) return this.props.children ?? null;
    return (
      <div data-testid="panel-error" role="alert" className="rounded border border-red-800 bg-red-950/60 p-3 text-xs text-red-200">
        <p className="font-bold">{this.props.name} failed to render: {this.state.error.message || String(this.state.error)}</p>
        <p className="mt-1 text-red-300">The header and KILL SWITCH still work. What this panel showed is not on screen.</p>
        <button type="button" onClick={() => this.setState({ error: null })} className="mt-2 underline">Try again</button>
      </div>
    );
  }
}

type RootState = BoundaryState & { kill: 'idle' | 'sending' | 'on' | 'failed'; killError?: string };

export class RootErrorBoundary extends React.Component<{ children?: React.ReactNode }, RootState> {
  declare props: { children?: React.ReactNode };
  declare setState: (s: Partial<RootState>) => void;
  state: RootState = { error: null, kill: 'idle' };
  static getDerivedStateFromError(error: Error): Partial<RootState> { return { error }; }
  componentDidCatch(error: Error) { console.error('[ui] the app failed to render:', error); }
  private engage = async () => {
    this.setState({ kill: 'sending' });
    try {
      const res = await authFetch('/api/execution/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activate: true }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.killSwitchActive !== true) throw new Error(body.error || `server answered HTTP ${res.status}`);
      this.setState({ kill: 'on' });
    } catch (e: any) {
      this.setState({ kill: 'failed', killError: e?.message || 'request failed' });
    }
  };
  render() {
    if (!this.state.error) return this.props.children ?? null;
    const { kill, killError } = this.state;
    return (
      <div className="min-h-screen bg-[#06080D] p-6 font-mono text-sm text-slate-200">
        <p className="font-bold text-red-300">The dashboard failed to render: {this.state.error.message || String(this.state.error)}</p>
        <p className="mt-1 text-slate-400">The server keeps running, and so do its exits. Use the button below to stop new orders, then reload.</p>
        <button type="button" data-testid="fallback-kill-switch" disabled={kill === 'sending' || kill === 'on'} onClick={() => { void this.engage(); }}
          className="mt-4 rounded bg-red-700 px-4 py-2 font-bold text-white disabled:opacity-60">KILL SWITCH</button>
        {kill === 'on' && <p className="mt-2 text-red-300">The server confirmed: the kill switch is ON. New orders are refused; open positions are not sold.</p>}
        {kill === 'failed' && <p className="mt-2 text-amber-300">The server did not confirm the kill switch ({killError}). Assume trading is NOT halted.</p>}
        <button type="button" onClick={() => window.location.reload()} className="mt-4 ml-3 underline">Reload</button>
      </div>
    );
  }
}
