import React from 'react';
import { AlertTriangle } from 'lucide-react';

export const SYNTHETIC_BANNER_TEXT = 'Simulated: synthetic price paths, not historical results';

/** B4: shown on every view whose numbers come from a pseudo-random simulation rather than recorded market data. */
export const SyntheticBanner: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div
    role="note"
    data-testid="synthetic-banner"
    className={`flex items-center space-x-2 px-3 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[11px] font-mono ${className}`}
  >
    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
    <span>
      <strong>{SYNTHETIC_BANNER_TEXT}.</strong> Results come from a seeded random generator and say nothing about live performance.
    </span>
  </div>
);
