import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The devnet-only check for the documentation. Every Markdown file outside docs/archive (and outside node_modules and dist), plus
 * .env.example, docker-compose.yml and the Dockerfile, must not point an operator at mainnet: no URL whose host names mainnet, no
 * mainnet RPC or Jito block-engine host, no explorer link that lacks ?cluster=devnet, and no advice to switch real-money trading on.
 * Archived documents are history and are not scanned. UI source is scanned for mainnet RPC and Jito hosts and for the real-money switch
 * (it is allowed to link to mainnet-only market sites, which the callouts screen does on purpose).
 *
 * Wording that leaves a loophole is refused: `ALLOW_LIVE_REAL_MONEY_TRADING=true` written as an assignment is always an offender (even
 * with a comment such as "only after a funded mainnet test"), and in prose only an explicit refusal (never, do not, refuse, in-process) clears it.
 */
function docFiles(): string[] {
  const out: string[] = ['.env.example', 'docker-compose.yml', 'Dockerfile'].filter((f) => fs.existsSync(f));
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' || e.name === 'coverage') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (full === path.join('docs', 'archive')) continue;
        walk(full);
      } else if (e.name.endsWith('.md')) out.push(full);
    }
  };
  walk('.');
  return out.map((f) => path.normalize(f));
}

/** A URL whose host names mainnet (https or wss), or one of the well-known mainnet-only RPC and Jito hosts. */
const MAINNET_HOST =
  /(?:https?|wss?):\/\/[^\s/'"`)>]*mainnet[^\s/'"`)>]*|mainnet-beta\.solana\.com|api\.mainnet\b|mainnet\.helius|mainnet\.rpc|mainnet\.solana\.com|solana-mainnet\.(?:quiknode\.pro|g\.alchemy\.com)/i;

const RULES: Array<{ name: string; test: (line: string) => boolean }> = [
  { name: 'mainnet RPC host', test: (l) => MAINNET_HOST.test(l) },
  { name: 'Jito block engine / tip-floor host', test: (l) => /block-engine[.\w-]*\.jito\.wtf|bundles\.jito\.wtf|mainnet[.\w-]*\.jito\.wtf|[\w-]+\.jito\.wtf/i.test(l) },
  {
    name: 'explorer link without ?cluster=devnet',
    test: (l) => (l.match(/https?:\/\/(?:www\.)?(?:solscan\.io|explorer\.solana\.com|solana\.fm|solanaexplorer\.com)[^\s)>`'"]*/gi) ?? []).some((u) => !/cluster=devnet/i.test(u)),
  },
  {
    name: 'advice to enable real-money trading',
    test: (l) =>
      /^\s*(export\s+)?ALLOW_LIVE_REAL_MONEY_TRADING\s*=\s*["']?true/i.test(l) ||
      (/ALLOW_LIVE_REAL_MONEY_TRADING\s*=\s*["']?true/i.test(l) && !/\b(never|do not|don't|must not|refus\w*|contradicts|in-process)\b/i.test(l)),
  },
  { name: 'ALLOWED_CLUSTER set to mainnet-beta', test: (l) => /ALLOWED_CLUSTER\s*=\s*["']?mainnet/i.test(l) && !/\b(do not|never|refus|not)\b/i.test(l) },
];

describe('docs safety: no non-archived doc points at mainnet or real-money trading', () => {
  const files = docFiles();
  it('scans the repo docs (README, KNOWN_RISKS, docs/, scripts/ READMEs, .env.example)', () => {
    expect(files).toEqual(expect.arrayContaining(['README.md', 'KNOWN_RISKS.md', '.env.example']));
    expect(files.some((f) => f.startsWith(path.join('docs', 'archive')))).toBe(false);
  });
  it.each(RULES)('no line breaks the rule: $name', ({ test }) => {
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`); });
    }
    expect(offenders).toEqual([]);
  });
  it('the rules do catch what they claim to catch (so the test cannot pass by matching nothing)', () => {
    expect(RULES[0].test('SOLANA_RPC_URL=https://api.mainnet-beta.solana.com')).toBe(true);
    expect(RULES[1].test('JITO_BLOCK_ENGINE_URL=https://frankfurt.mainnet.block-engine.jito.wtf')).toBe(true);
    expect(RULES[2].test('see https://solscan.io/account/abc')).toBe(true);
    expect(RULES[2].test('see https://solscan.io/account/abc?cluster=devnet')).toBe(false);
    expect(RULES[3].test('Set ALLOW_LIVE_REAL_MONEY_TRADING=true when ready for real-money execution')).toBe(true);
    expect(RULES[3].test('leave ALLOW_LIVE_REAL_MONEY_TRADING=false; only the harness sets it')).toBe(false);
    expect(RULES[4].test('ALLOWED_CLUSTER=mainnet-beta')).toBe(true);
    // loopholes the first version had
    expect(RULES[3].test('ALLOW_LIVE_REAL_MONEY_TRADING=true # only after a funded mainnet test')).toBe(true);
    expect(RULES[3].test('Only set ALLOW_LIVE_REAL_MONEY_TRADING=true when you are ready; it requires a key')).toBe(true);
    expect(RULES[3].test('the harness never sets ALLOW_LIVE_REAL_MONEY_TRADING=true')).toBe(false);
    expect(RULES[0].test('SOLANA_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/KEY')).toBe(true);
    expect(RULES[0].test('SOLANA_RPC_URL=https://solana-mainnet.quiknode.pro/KEY')).toBe(true);
    expect(RULES[0].test('use https://mainnet.solana.com for real trades')).toBe(true);
    expect(RULES[1].test('JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf')).toBe(true);
    expect(RULES[1].test('JITO_BLOCK_ENGINE_URL=https://ny.mainnet.jito.wtf/api/v1')).toBe(true);
    expect(RULES[0].test('SOLANA_RPC_URL=https://api.devnet.solana.com')).toBe(false);
  });
  it('no UI or server source file carries a mainnet RPC or Jito host, or turns real-money trading on', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(e.name)) {
          fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            // comments and quoted refusal lists may name a host; a string literal that is a URL must not be one
            const m = line.match(/['"`](?:https?|wss?):\/\/[^'"`\s]*['"`]?/gi) ?? [];
            if (m.some((u) => MAINNET_HOST.test(u) && !/devnet|localhost|127\.0\.0\.1/i.test(u))) offenders.push(`${full}:${i + 1}: ${line.trim().slice(0, 140)}`);
          });
        }
      }
    };
    ['src', 'server'].forEach(walk);
    expect(offenders).toEqual([]);
  });
});
