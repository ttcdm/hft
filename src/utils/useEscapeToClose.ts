import { useEffect } from 'react';

/** True for a key event that should close the open dialog. */
export const isEscapeKey = (e: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>): boolean => e.key === 'Escape' && !e.defaultPrevented;

/** S182: Escape closes a dialog, the same way for every modal. Registered only while the dialog is open. */
export function useEscapeToClose(isOpen: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (isEscapeKey(e)) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);
}
