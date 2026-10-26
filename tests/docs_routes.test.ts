import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_API_ALLOWLIST, isPublicApiRoute } from '../server/middleware/auth';

/**
 * P1.8 (R1-49, R1-128): every HTTP route an operator document names must exist. KNOWN_RISKS once told the operator to call
 * `POST /api/live/disarm` in an emergency; no such route was ever registered, so the call was a 404 while the operator believed
 * trading had stopped.
 *
 * Documents: README.md, KNOWN_RISKS.md and docs/*.md (not docs/archive, which is history). A route counts as named when it appears as
 * `METHOD /api/...` (also `METHOD $APEX/api/...` or `METHOD http://host/api/...`, which covers `curl -X POST ...`), or as the runbook's
 * `api $APEX/api/...` helper without `-X`, which is a GET. Registered routes: every `.get|post|put|delete|patch('/api/...'` in server.ts
 * and server/**.
 */
const METHODS = 'GET|POST|PUT|DELETE|PATCH';
const PATH_CHARS = "[A-Za-z0-9_\\-/:.<>{}]*";
const NAMED = new RegExp(`\\b(${METHODS})\\s+\`?(?:\\$\\{?\\w+\\}?|https?:\\/\\/[^\\s/\`'"]+)?(\\/api\\/${PATH_CHARS})`, 'g');
const RUNBOOK_GET = new RegExp(`\\bapi\\s+"?\\$APEX(\\/api\\/${PATH_CHARS})`, 'g');
const REGISTERED = new RegExp(`\\.(get|post|put|delete|patch)\\(\\s*(['"\`])(\\/api\\/[^'"\`]+)\\2`, 'g');

/** Routes a document names on purpose because they do NOT exist (it reports the mistake). Each entry must still be absent and still named. */
const NAMED_AS_ABSENT: Array<{ file: string; route: string }> = [];

const clean = (p: string) => p.replace(/[.,:;)]+$/, '').replace(/\/+$/, '');

function namedRoutes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NAMED)) out.push(`${m[1]} ${clean(m[2])}`);
  for (const m of text.matchAll(RUNBOOK_GET)) out.push(`GET ${clean(m[1])}`);
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

function registeredRoutes(): Array<{ method: string; re: RegExp; raw: string }> {
  const out: Array<{ method: string; re: RegExp; raw: string }> = [];
  for (const f of ['server.ts', ...sourceFiles('server')]) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(REGISTERED)) {
      const raw = m[3];
      // an Express `:param` segment matches any one segment
      const re = new RegExp(`^${raw.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
      out.push({ method: m[1].toUpperCase(), re, raw });
    }
  }
  return out;
}

function isRegistered(route: string, registered: ReturnType<typeof registeredRoutes>): boolean {
  const [method, p] = route.split(' ');
  // a placeholder in a document (`<mint>`, `{mint}`, `:mint`) stands for one segment
  const concrete = p.split('/').map((s) => (/^(?:<.*>|\{.*\}|:.+)$/.test(s) ? 'PLACEHOLDER' : s)).join('/');
  return registered.some((r) => r.method === method && r.re.test(concrete));
}

function docFiles(): string[] {
  const docs = fs.readdirSync('docs').filter((f) => /\.md$/i.test(f)).map((f) => path.join('docs', f));
  return ['README.md', 'KNOWN_RISKS.md', ...docs];
}

describe('docs routes: every API route a document names is registered', () => {
  const registered = registeredRoutes();

  it('finds the routes (so the test cannot pass by matching nothing), and every public route in the auth allowlist is one of them', () => {
    expect(registered.length).toBeGreaterThan(50);
    expect(isRegistered('POST /api/execution/kill-switch', registered)).toBe(true);
    expect(isRegistered('GET /api/market/curve/<mint>', registered)).toBe(true);
    expect(isRegistered('GET /api/execution/kill-switch', registered)).toBe(false); // the method matters
    expect(isRegistered('POST /api/live/disarm', registered)).toBe(false);
    expect(namedRoutes('Engage the kill switch via the UI or `POST /api/live/disarm`.')).toEqual(['POST /api/live/disarm']);
    expect(namedRoutes("api -X POST $APEX/api/execution/kill-switch -d '{}'")).toEqual(['POST /api/execution/kill-switch']);
    expect(namedRoutes('api "$APEX/api/workstation/positions?status=ACTIVE"')).toEqual(['GET /api/workstation/positions']);
    expect(namedRoutes('curl -X GET http://127.0.0.1:3000/api/health.')).toEqual(['GET /api/health']);
    expect(docFiles()).toEqual(expect.arrayContaining(['README.md', 'KNOWN_RISKS.md', path.join('docs', 'RUNBOOK.md')]));
    // the routes the auth gate lets through without a token (HEAD is answered by the GET route, OPTIONS is any path)
    const pub = PUBLIC_API_ALLOWLIST.filter((r) => r.method === 'GET' || r.method === 'POST');
    expect(pub.length).toBeGreaterThan(0);
    for (const r of pub) expect(isRegistered(`${r.method} ${r.path}`, registered), `${r.method} ${r.path}`).toBe(true);
  });

  it('README, KNOWN_RISKS and docs/*.md name no route that the server does not register', () => {
    const offenders: string[] = [];
    const publicNamed = new Set<string>();
    let named = 0;
    for (const f of docFiles()) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        for (const route of namedRoutes(line)) {
          named++;
          const [method, p] = route.split(' ');
          if (isPublicApiRoute(method, p)) publicNamed.add(route);
          if (isRegistered(route, registered)) continue;
          if (NAMED_AS_ABSENT.some((a) => a.file === f && a.route === route)) continue;
          offenders.push(`${f}:${i + 1}: ${route}`);
        }
      });
    }
    expect(named).toBeGreaterThan(40);
    expect(offenders).toEqual([]);
    // the runbook says every route but these two needs the operator token; the auth gate must agree for every route the docs name
    expect([...publicNamed].sort()).toEqual(['GET /api/health', 'POST /api/auth/login']);
    // a route named on purpose as absent must still be absent and still be named, so the list cannot hide a real mistake for long
    for (const a of NAMED_AS_ABSENT) {
      expect(isRegistered(a.route, registered), a.route).toBe(false);
      expect(namedRoutes(fs.readFileSync(a.file, 'utf8')), a.file).toContain(a.route);
      expect(isPublicApiRoute(a.route.split(' ')[0], a.route.split(' ')[1]), a.route).toBe(false);
    }
  });
});
