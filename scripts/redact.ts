/**
 * Text the devnet harness prints goes through here first, so a private RPC URL (its key sits in the path or query, and its host names the
 * endpoint) never reaches the screen. No imports: safe to load before the harness has set its environment.
 */

/** Replaces anything URL-shaped with <url>. */
export function scrubUrls(text: string): string {
  return String(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi, '<url>');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Removes the given secret URLs from text in every form they can appear in: the whole URL, the host (and the endpoint's own leading label),
 * each path segment of six characters or more, and each query value. Then scrubs any other URL. A partial tail of the host (a cut-off
 * log line) is covered too: every suffix of the host of eight characters or more is removed.
 */
export function redact(text: string, secretUrls: Array<string | undefined>): string {
  let out = String(text);
  for (const raw of secretUrls) {
    if (!raw) continue;
    out = out.split(raw).join('<rpc>');
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const pieces = new Set<string>();
    pieces.add(u.host);
    const label = u.hostname.split('.')[0];
    if (label.length >= 4) pieces.add(label);
    for (let i = 0; i + 8 <= u.host.length; i++) pieces.add(u.host.slice(i)); // suffixes of the host
    for (const seg of u.pathname.split('/')) if (seg.length >= 6) pieces.add(seg);
    for (const v of u.searchParams.values()) if (v.length >= 4) pieces.add(v);
    if (u.username) pieces.add(u.username);
    if (u.password) pieces.add(u.password);
    for (const piece of [...pieces].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escape(piece), 'g'), '<rpc>');
  }
  return scrubUrls(out);
}

/**
 * A short, safe account of a child process that did not do what the harness expected: how it ended, the first sentence of an
 * INSTANCE_LOCKED refusal if it printed one (the lock path and the holder's pid; devnet run 2026-10-27's (f) report kept only the end of
 * that message), then the last few lines of what it printed, with the devnet guard's own network log lines left out (they are noise
 * here) and every secret removed. At most CHILD_REPORT_MAX characters: the tail is cut, never the head.
 */
export const CHILD_REPORT_MAX = 800;
export function childReport(
  r: { status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout?: string | null; stderr?: string | null },
  secretUrls: Array<string | undefined>,
  lines = 6
): string {
  const how = r.error ? `did not finish (${(r.error as NodeJS.ErrnoException).code ?? 'error'})` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  const keep = (t?: string | null) => String(t ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('[devnet-guard]'));
  const all = [...keep(r.stdout), ...keep(r.stderr)];
  const lockedLine = all.find((l) => l.includes('INSTANCE_LOCKED'));
  const locked = lockedLine ? lockedLine.slice(lockedLine.indexOf('INSTANCE_LOCKED')) : '';
  const lockedFirst = locked ? (/^INSTANCE_LOCKED: .*?\)\./.exec(locked)?.[0] ?? locked).slice(0, 400) : '';
  const head = redact(lockedFirst ? `${how}; ${lockedFirst}` : how, secretUrls);
  const tail = redact(`; last output: ${all.slice(-lines).join(' | ') || '(none)'}`, secretUrls);
  const room = Math.max(0, CHILD_REPORT_MAX - head.length);
  return head + (tail.length <= room ? tail : `; last output: ...${tail.slice(tail.length - Math.max(0, room - 18))}`);
}
