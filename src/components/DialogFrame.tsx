import React, { useRef } from 'react';
import { useDialogFocus } from '../utils/dialogFocus';

/** R10-11: the outer layer of every modal: role=dialog, aria-modal, a name, and a focus trap (see useDialogFocus). */
export function DialogFrame({ label, className, alsoReach, children, testId }: { label: string; className: string; alsoReach?: string[]; children: React.ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, { alsoReach });
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={`${className} outline-none`} data-testid={testId}>
      {children}
    </div>
  );
}

/** The header KILL SWITCH stays reachable from panels that open below the header. */
export const KILL_SWITCH_ID = 'btn-emergency-kill-switch';
