import React, { useEffect, useRef, useState } from 'react';
import { useDialogFocus } from '../utils/dialogFocus';

/**
 * R10-11: the confirm step for actions that sell (PANIC, KILL AUTO). window.confirm accepts on Enter, so a stray Enter sold everything.
 * This dialog opens with Cancel focused, refuses Enter on the confirm button (it takes a click, or Space once the operator has tabbed to
 * it), and Escape or a click outside cancels. With no ConfirmHost on the page the answer is no: nothing is sold without the question.
 */
export interface ConfirmRequest { title: string; body: string; confirmLabel: string }
type Pending = ConfirmRequest & { resolve: (yes: boolean) => void };

let current: Pending | null = null;
const queue: Pending[] = [];
const hosts = new Set<() => void>();
const notify = () => hosts.forEach((fn) => fn());

export function askConfirm(req: ConfirmRequest): Promise<boolean> {
  if (hosts.size === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = { ...req, resolve };
    if (current) queue.push(p); else current = p;
    notify();
  });
}

function answer(yes: boolean): void {
  const p = current;
  current = queue.shift() ?? null;
  notify();
  p?.resolve(yes);
}

export function ConfirmHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    hosts.add(fn);
    return () => { hosts.delete(fn); if (hosts.size === 0 && current) answer(false); };
  }, []);
  return current ? <React.Fragment key={`${current.title}|${current.body}`}><ConfirmDialogView req={current} onAnswer={answer} /></React.Fragment> : null;
}

export function ConfirmDialogView({ req, onAnswer }: { req: ConfirmRequest; onAnswer: (yes: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(ref, true, { initial: () => cancelRef.current });
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onAnswer(false); return; }
    // Enter never accepts: on the confirm button it does nothing, anywhere else it is the browser's (Cancel has focus by default)
    if (e.key === 'Enter' && (e.target as HTMLElement).getAttribute('data-testid') === 'confirm-ok') e.preventDefault();
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onAnswer(false); }}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body" tabIndex={-1} onKeyDown={onKey}
        className="bg-slate-900 border border-rose-500/60 rounded-xl p-5 max-w-md w-full space-y-4 shadow-2xl outline-none font-mono text-xs">
        <h2 id="confirm-title" className="text-rose-300 font-bold text-sm">{req.title}</h2>
        <p id="confirm-body" className="text-slate-300 whitespace-pre-line">{req.body}</p>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} data-testid="confirm-cancel" onClick={() => onAnswer(false)} className="px-3 py-1.5 rounded border border-slate-600 text-slate-200 hover:text-white">Cancel</button>
          <button data-testid="confirm-ok" onClick={() => onAnswer(true)} className="px-3 py-1.5 rounded bg-rose-700 hover:bg-rose-600 text-white font-bold">{req.confirmLabel}</button>
        </div>
        <p className="text-slate-500 text-[10px]">Enter does not confirm. Click the red button to go ahead; Escape cancels.</p>
      </div>
    </div>
  );
}

/** A click that sends a real transaction while LIVE is armed (the text is liveClickWarning's). */
export const confirmLiveClick = (warning: string): Promise<boolean> => askConfirm({ title: 'LIVE ORDER', body: warning, confirmLabel: 'Send the real transaction' });
/** A sell (the text is sellConfirmText's). */
export const confirmSell = (ask: string): Promise<boolean> => askConfirm({ title: 'SELL', body: ask, confirmLabel: 'Sell' });
