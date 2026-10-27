/**
 * Import this FIRST in a DOM test file, before react-dom. react-dom decides at load time whether it runs in a browser (for example
 * whether the `input` event exists, which onChange needs); in the node environment there is no window yet, so a happy-dom window is
 * put on globalThis here. `installDom()` (domApp.tsx) then gives each test a fresh one.
 */
import { Window } from 'happy-dom';

if (typeof (globalThis as any).window === 'undefined') {
  const win: any = new Window({ url: 'http://localhost:3000/' });
  const g = globalThis as any;
  g.window = win;
  for (const k of ['document', 'navigator', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event', 'MutationObserver']) {
    if (g[k] === undefined) g[k] = win[k];
  }
}
