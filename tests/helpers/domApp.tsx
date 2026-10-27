/**
 * Renders the real <App/> in happy-dom. The only stubs are at the network boundary: global fetch answers from a small in-memory
 * server (`routes`), and WebSocket is a socket that never opens. Everything in src/ runs as shipped.
 *
 * The test file stays in the node environment (the shared setup file imports server code, which vite will not bundle for a browser
 * environment); `installDom()` puts a happy-dom window on globalThis instead.
 */
import './domGlobals';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { vi } from 'vitest';
import { Window } from 'happy-dom';

export type Route = (body: any, init: RequestInit | undefined, url: string) => { status?: number; json: any } | undefined;

export interface FakeServer {
  calls: { url: string; method: string; body: any }[];
  /** Exact path (no query) to handler. A handler returning undefined falls through to the default. */
  routes: Record<string, Route>;
  killSwitchActive: boolean;
  /** When set and true for a path, the server answers 401 (a cleared or refused token). */
  deny?: (path: string) => boolean;
}

class NeverOpenSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  constructor(public url: string) {}
  send() {}
  close() { this.readyState = 3; }
  addEventListener() {}
  removeEventListener() {}
}

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'HTMLIFrameElement', 'HTMLInputElement', 'Element',
  'Node', 'Text', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'InputEvent', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'DocumentFragment', 'SVGElement', 'ResizeObserver', 'IntersectionObserver', 'matchMedia',
  'AudioContext', 'confirm', 'alert', 'prompt',
];
let installedWindow: any = null;

/** Puts a happy-dom window on globalThis. Call once per test (beforeEach); `removeDom()` in afterEach. */
export function installDom(width = 1440): any {
  const win: any = new Window({ url: 'http://localhost:3000/', width, height: 900 });
  win.confirm = () => true;
  win.alert = () => undefined;
  installedWindow = win;
  for (const k of DOM_GLOBALS) {
    if (win[k] !== undefined) vi.stubGlobal(k, k === 'window' ? win : typeof win[k] === 'function' && /^[a-z]/.test(k) ? win[k].bind(win) : win[k]);
  }
  vi.stubGlobal('window', win);
  return win;
}

let mountedRoot: Root | null = null;

export async function removeDom(): Promise<void> {
  if (mountedRoot) { const r = mountedRoot; mountedRoot = null; await act(async () => r.unmount()); }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (installedWindow) { await installedWindow.happyDOM?.abort?.(); installedWindow.close?.(); installedWindow = null; }
}

export function installFakeServer(server: FakeServer, defaults: Record<string, any> = {}): void {
  vi.stubGlobal('WebSocket', NeverOpenSocket);
  (window as any).WebSocket = NeverOpenSocket;
  const fetchStub = async (input: any, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    let body: any;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
    server.calls.push({ url: path, method: (init?.method || 'GET').toUpperCase(), body });
    if (server.deny?.(path)) return new Response(JSON.stringify({ error: 'Operator token required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const handler = server.routes[path];
    const hit = handler ? handler(body, init, raw) : undefined;
    if (hit) return new Response(JSON.stringify(hit.json), { status: hit.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/execution/kill-switch') {
      server.killSwitchActive = body?.activate === true;
      return new Response(JSON.stringify({ success: true, killSwitchActive: server.killSwitchActive }), { status: 200 });
    }
    if (path === '/api/diagnostics/system') {
      return new Response(JSON.stringify({ systemAudit: { killSwitchActive: server.killSwitchActive } }), { status: 200 });
    }
    if (path in defaults) return new Response(JSON.stringify(defaults[path]), { status: 200 });
    return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404 });
  };
  const f = vi.fn(fetchStub);
  vi.stubGlobal('fetch', f);
  (window as any).fetch = f;
}

export async function renderApp(): Promise<{ root: Root; container: HTMLElement; unmount: () => Promise<void> }> {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  try { localStorage.setItem('apex_operator_token', 'test-token'); } catch { /* storage unavailable */ }
  const { default: App } = await import('../../src/App');
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoot = root;
  await act(async () => { root.render(<App />); });
  await flush();
  return {
    root,
    container,
    unmount: async () => { if (mountedRoot === root) { mountedRoot = null; await act(async () => root.unmount()); } container.remove(); },
  };
}

/** Let pending fetches and the state updates they cause settle. */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('element not found');
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
}

/** Types into a React-controlled input: set the value through the native setter, then fire `input`, as a browser does. */
export async function typeInto(el: Element | null, value: string): Promise<void> {
  if (!el) throw new Error('input not found');
  const input = el as HTMLInputElement;
  let proto = Object.getPrototypeOf(input);
  let setter: ((v: string) => void) | undefined;
  while (proto && !setter) { setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; proto = Object.getPrototypeOf(proto); }
  await act(async () => {
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new (window as any).Event('input', { bubbles: true }));
    input.dispatchEvent(new (window as any).Event('change', { bubbles: true }));
  });
  await flush();
}

/** Runs the real express validation middleware for `schema` on `body` and returns the status and JSON it would answer. */
export function middlewareAnswer(mw: (req: any, res: any, next: () => void) => void, body: unknown): { status: number; json: any } | undefined {
  let out: { status: number; json: any } | undefined;
  let code = 200;
  const res = { status(c: number) { code = c; return res; }, json(j: any) { out = { status: code, json: j }; return res; } };
  mw({ body }, res, () => undefined);
  return out;
}
