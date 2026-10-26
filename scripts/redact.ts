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
 * A short, safe account of a child process that did not do what the harness expected: how it ended, then the last few lines of what it
 * printed, with the devnet guard's own network log lines left out (they are noise here) and every secret removed.
 */
export function childReport(
  r: { status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout?: string | null; stderr?: string | null },
  secretUrls: Array<string | undefined>,
  lines = 6
): string {
  const how = r.error ? `did not finish (${(r.error as NodeJS.ErrnoException).code ?? 'error'})` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  const keep = (t?: string | null) => String(t ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('[devnet-guard]'));
  const tail = [...keep(r.stdout), ...keep(r.stderr)].slice(-lines).join(' | ');
  return redact(`${how}; last output: ${tail || '(none)'}`, secretUrls).slice(-500);
}
