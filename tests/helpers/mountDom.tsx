import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { flush } from './domApp';

/** Mounts one element in the happy-dom document (installDom first) and returns its container and an unmount. */
export async function mount(el: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  try { localStorage.setItem('apex_operator_token', 'test-token'); } catch { /* storage unavailable */ }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(el); });
  await flush();
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

/** The first button whose text matches. */
export const buttonByText = (scope: ParentNode, re: RegExp): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll('button')].find((b) => re.test(b.textContent || '')) as HTMLButtonElement | undefined;
