import { useEffect, type RefObject } from 'react';

/**
 * R10-11: an open dialog keeps keyboard focus. Tab and Shift+Tab cycle through the dialog's own controls (plus any outside element named
 * in `alsoReach`, such as the header KILL SWITCH, which stays on screen above the Plug & Play and sniper panels); nothing behind the dialog
 * is reached. Only the topmost open dialog handles Tab. Focus goes into the dialog when it opens and back where it was when it closes.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const stack: HTMLElement[] = [];

export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');
}

/** The next element for Tab (or Shift+Tab) in `order`, wrapping; the first (or last) when focus is not in it. */
export function nextInCycle(order: HTMLElement[], current: Element | null, back: boolean): HTMLElement | null {
  if (order.length === 0) return null;
  const i = current ? order.indexOf(current as HTMLElement) : -1;
  if (i < 0) return back ? order[order.length - 1] : order[0];
  return order[(i + (back ? -1 : 1) + order.length) % order.length];
}

export function useDialogFocus(ref: RefObject<HTMLElement | null>, active: boolean, opts: { initial?: () => HTMLElement | null; alsoReach?: string[] } = {}): void {
  const { initial, alsoReach } = opts;
  const reachKey = (alsoReach ?? []).join(',');
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const before = document.activeElement as HTMLElement | null;
    stack.push(root);
    (initial?.() ?? root).focus?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || stack[stack.length - 1] !== root) return;
      const outside = reachKey ? reachKey.split(',').map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el && !(el as HTMLButtonElement).disabled) : [];
      const next = nextInCycle([...focusablesIn(root), ...outside], document.activeElement, e.shiftKey);
      e.preventDefault();
      next?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const at = stack.lastIndexOf(root);
      if (at >= 0) stack.splice(at, 1);
      if (before && document.contains(before)) before.focus?.();
    };
  }, [active, ref, reachKey]);
}
