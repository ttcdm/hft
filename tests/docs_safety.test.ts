import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * A tripwire for the obvious ways a document, config file or source file could point an operator at mainnet or real-money trading. It is
 * not a barrier: a determined rewording can still get past it, and review has to catch the rest.
 *
 * What it scans (only files git tracks, so a developer's untracked notes such as .agents/ or .overnight/ never count; where git is not
 * available it walks the tree and skips every dot-directory except .github):
 *  - docs: every Markdown file (any case of `.md`) outside docs/archive, plus .env.example, docker-compose.yml, the Dockerfile and any
 *    .yml/.yaml under .github/. Archived documents are history and are not scanned.
 *  - code: src/ and server/ for string literals that are URLs on a mainnet host, and server.ts, scripts/, package.json and .github/ for the
 *    real-money switch turned on (see below).
 *
 * What it refuses:
 *  - a URL whose host names mainnet, and the known mainnet-only RPC and Jito hosts, `api.solana.com` included;
 *  - an explorer link (solscan, explorer.solana.com, solana.fm, solanaexplorer), with or without the scheme, that lacks `?cluster=devnet`;
 *  - `ALLOWED_CLUSTER` set to mainnet-beta;
 *  - real-money wallet framing: "cold wallet", "cold storage", "treasury", "import your/an existing wallet or key" (no exemption);
 *  - `solana transfer` on a line without `--url devnet`;
 *  - the real-money switch (`ALLOW_LIVE_REAL_MONEY_TRADING`) turned on, in any of these forms: `KEY=true`, YAML `KEY: true`, a table cell
 *    `KEY | true`, or prose such as "set KEY to true" / "KEY is true" (and the values 1, yes, on).
 *
 * How the exemptions work: they are per clause, not per line. Only a refusal word in the same sentence BEFORE the match clears it (for
 * example "do not set ALLOWED_CLUSTER=mainnet-beta", "the harness never sets KEY=true"). A comment after the match, such as
 * `# not tested yet` or `# only after a funded mainnet test`, clears nothing. The one fixed exception is an in-process harness: scripts
 * under scripts/localnet/ and scripts/devnet_e2e.ts may set the switch inside a TypeScript object or `process.env` assignment, because
 * they run it against a local or devnet validator after checking the genesis hash.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);

/** Files git tracks, or null when this is not a git checkout. */
function trackedFiles(): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\0').filter(Boolean).map((f) => path.normalize(f));
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/** Every file under the repo: tracked files when git is available, else a walk that skips dot-directories (except .github). */
function repoFiles(): string[] {
  const tracked = trackedFiles();
  if (tracked) return tracked.filter((f) => fs.existsSync(f));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.isDirectory() && e.name !== '.github')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.normalize(full));
    }
  };
  walk('.');
  return out;
}

function docFiles(): string[] {
  const all = repoFiles();
  const named = ['.env.example', 'docker-compose.yml', 'Dockerfile'].filter((f) => all.includes(f));
  const md = all.filter((f) => /\.md$/i.test(f) && !f.startsWith(path.join('docs', 'archive') + path.sep));
  const ghYaml = all.filter((f) => f.startsWith('.github' + path.sep) && /\.ya?ml$/i.test(f));
  return [...new Set([...named, ...md, ...ghYaml])];
}

function codeFiles(): string[] {
  const exts = /\.(?:[cm]?[jt]sx?|json|sh|ya?ml)$/i;
  return repoFiles().filter((f) =>
    ((f.startsWith('src' + path.sep) || f.startsWith('server' + path.sep)) && /\.[jt]sx?$/.test(f)) ||
    (f.startsWith('scripts' + path.sep) && exts.test(f)) ||
    f === 'server.ts' || f === 'package.json' ||
    (f.startsWith('.github' + path.sep) && exts.test(f)));
}

/** A host that names mainnet, or one of the well-known mainnet-only RPC and Jito hosts. Tested on a URL's host only, where there is a URL. */
const MAINNET_HOST_RE = /mainnet|(?:^|\.)api\.solana\.com$|(?:^|\.)jito\.wtf$/i;
const MAINNET_ANYWHERE = /(?:https?|wss?):\/\/[^\s/'"`)>]*mainnet[^\s/'"`)>]*|mainnet-beta\.solana\.com|api\.mainnet\b|mainnet\.helius|mainnet\.rpc|mainnet\.solana\.com|solana-mainnet\.(?:quiknode\.pro|g\.alchemy\.com)|(?<![\w.-])api\.solana\.com|[\w-]+\.jito\.wtf/i;

const REFUSAL = /\b(?:never|do not|don't|must not|refus\w*|reject\w*|without|contradicts|not (?:set|use|enable|turn))\b/i;

/** True when a refusal word appears in the same sentence BEFORE `index`. */
function refusedBefore(line: string, index: number): boolean {
  const before = line.slice(0, index);
  const sentence = before.split(/[.;!?]\s|[.;!?]$/).pop() ?? before;
  return REFUSAL.test(sentence);
}

function flagsWithPrefixExemption(line: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of line.matchAll(g)) if (!refusedBefore(line, m.index ?? 0)) return true;
  return false;
}

const SWITCH = 'ALLOW_LIVE_REAL_MONEY_TRADING';
const ON = '(?:true|1|yes|on)';
/** KEY=true, KEY: true, KEY | true, "KEY": "true", KEY is/to/as/=> true. The key may be wrapped in backticks, quotes or table pipes. */
const SWITCH_ON = new RegExp(`${SWITCH}[\`"']*\\s*(?:=|:|\\||\\bis\\b|\\bto\\b|\\bas\\b|=>)\\s*[\`"']*${ON}\\b`, 'i');

const BOOT_RECIPE = /\bnode\s+(?:\S*\/)?dist\/server\.cjs\b/;
function unsafeBootRecipe(line: string): boolean {
  if (!BOOT_RECIPE.test(line)) return false;
  const scratchState = /scratch cwd|scratch \(`?mkdtemp`?\) cwd|mkdtemp|mktemp|APEX_DB_PATH/.test(line);
  return !(scratchState && /SIGNER_KEYPAIR_PATH/.test(line));
}

const RULES: Array<{ name: string; test: (line: string) => boolean }> = [
  { name: 'mainnet RPC or Jito host', test: (l) => MAINNET_ANYWHERE.test(l) },
  {
    name: 'explorer link without ?cluster=devnet',
    test: (l) => (l.match(/(?:https?:\/\/)?(?:www\.)?(?:solscan\.io|explorer\.solana\.com|solana\.fm|solanaexplorer\.com)[^\s)>`'"]*/gi) ?? []).some((u) => !/cluster=devnet/i.test(u)),
  },
  { name: 'advice to enable real-money trading', test: (l) => flagsWithPrefixExemption(l, SWITCH_ON) },
  { name: 'ALLOWED_CLUSTER set to mainnet-beta', test: (l) => flagsWithPrefixExemption(l, /ALLOWED_CLUSTER[`"']*\s*(?:=|:|\bto\b|\bis\b)\s*[`"']*mainnet/i) },
  // P1.8 (R1-137, R1-128): the key is a throwaway devnet key. Real-money wallet framing has no place in these docs, not even negated
  // ("never use your treasury wallet" still tells the reader one might be used), so these rules have no refusal exemption.
  { name: 'cold wallet or treasury framing', test: (l) => /\bcold[\s-]?(?:wallet|storage)\b|\btreasur(?:y|ies)\b/i.test(l) },
  { name: 'advice to import an existing wallet or key', test: (l) => /\bimport\s+(?:your|an\s+existing)\s+(?:own\s+)?(?:wallet|key)/i.test(l) },
  // the Solana CLI's default cluster is not devnet, so a transfer must name it
  { name: 'solana transfer without --url devnet', test: (l) => /\bsolana\s+transfer\b/i.test(l) && !/--url[\s=]devnet\b/.test(l) },
  // N-58: a booted server is a full instance (it reads `.env`, opens `./apex_workstation.db`, loads `./.apex_trading_keypair.json` and adopts
  // the wallet's tokens), so a recipe that boots `node dist/server.cjs` must say, on the same line, where its state and key come from.
  { name: 'a node dist/server.cjs recipe without a scratch cwd or APEX_DB_PATH, and SIGNER_KEYPAIR_PATH', test: unsafeBootRecipe },
];

/** In-process harnesses that may set the switch inside a TypeScript object or process.env assignment. */
const HARNESS = (f: string) => f.startsWith(path.join('scripts', 'localnet') + path.sep) || f === path.join('scripts', 'devnet_e2e.ts');

/** Code: the switch on in shell, YAML or JSON form anywhere, or in object form outside the harnesses. server.ts and package.json get no object-form exemption either. */
function codeSwitchOn(file: string, line: string): boolean {
  if (!line.includes(SWITCH)) return false;
  const objectForm = /\.ts$/.test(file) && HARNESS(file);
  if (objectForm) return false;
  return new RegExp(`${SWITCH}[\`"']*\\s*(?:=|:)\\s*[\`"']*${ON}\\b`, 'i').test(line) && !/process\.env\.[A-Z_]+\s*(?:!==|===)/.test(line);
}

describe('docs safety: nothing points at mainnet or real-money trading', () => {
  const files = docFiles();
  it('scans the repo docs (README, KNOWN_RISKS, docs/, scripts/ READMEs, .env.example, docker-compose.yml)', () => {
    expect(files).toEqual(expect.arrayContaining(['README.md', 'KNOWN_RISKS.md', '.env.example', 'docker-compose.yml', path.join('docs', 'ENV.md')]));
    expect(files.some((f) => f.startsWith(path.join('docs', 'archive')))).toBe(false);
  });
  it.each(RULES)('no doc line breaks the rule: $name', ({ test }) => {
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`); });
    }
    expect(offenders).toEqual([]);
  });
  it('scans only tracked files, never a developer\'s untracked notes or other dot-directories', () => {
    for (const f of [...files, ...codeFiles()]) {
      const top = f.split(path.sep)[0];
      expect(top.startsWith('.') && top !== '.github' && f !== '.env.example', `${f} is under a dot-directory`).toBe(false);
    }
    expect(files.some((f) => /^\.(?:agents|overnight)/.test(f))).toBe(false);
  });
  it('no source URL literal has a mainnet host (src/, server/)', () => {
    const offenders: string[] = [];
    for (const f of codeFiles().filter((x) => x.startsWith('src' + path.sep) || x.startsWith('server' + path.sep))) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.match(/['"`](?:https?|wss?):\/\/[^'"`\s]*/gi) ?? []) {
          let host: string;
          try { host = new URL(m.slice(1)).hostname; } catch { host = m; }
          if (MAINNET_HOST_RE.test(host)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
        }
      });
    }
    // The cluster guard names the mainnet hosts it refuses; those files are the only ones allowed to.
    const allowed = (o: string) => /^server[\\/]solana[\\/](?:clusterGuard|executionConfig|transports)\.ts:/.test(o) || /^src[\\/](?:utils[\\/]tokenLinks|components[\\/]PumpFunHotCalloutsView)\.tsx?:/.test(o);
    expect(offenders.filter((o) => !allowed(o))).toEqual([]);
  });
  it('the real-money switch is not turned on in server.ts, package.json, shell or YAML, or in scripts outside the in-process harnesses', () => {
    const offenders: string[] = [];
    for (const f of codeFiles().filter((x) => !x.startsWith('src' + path.sep) && !x.startsWith('server' + path.sep))) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (codeSwitchOn(f, line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`); });
    }
    expect(offenders).toEqual([]);
  });
  it('the harness exemption covers only the localnet and devnet scripts', () => {
    expect(HARNESS(path.join('scripts', 'localnet', 'e2e.ts'))).toBe(true);
    expect(HARNESS(path.join('scripts', 'devnet_e2e.ts'))).toBe(true);
    expect(HARNESS(path.join('scripts', 'other.ts'))).toBe(false);
    expect(codeSwitchOn('server.ts', "process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true'")).toBe(true);
    expect(codeSwitchOn('scripts/other.ts', "process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'false'")).toBe(false);
    expect(codeSwitchOn('package.json', '"start": "ALLOW_LIVE_REAL_MONEY_TRADING=true node server.cjs"')).toBe(true);
    expect(codeSwitchOn('scripts/run.ts', "env: { ALLOW_LIVE_REAL_MONEY_TRADING: 'true' }")).toBe(true);
    expect(codeSwitchOn(path.join('scripts', 'localnet', 'e2e.ts'), "ALLOW_LIVE_REAL_MONEY_TRADING: 'true',")).toBe(false);
    expect(codeSwitchOn('.github/workflows/ci.yml', '      ALLOW_LIVE_REAL_MONEY_TRADING: "true"')).toBe(true);
  });
  it('the rules catch what they claim to catch (so the test cannot pass by matching nothing)', () => {
    const [host, explorer, money, cluster] = RULES.map((r) => r.test);
    const boot = RULES.find((r) => r.name.startsWith('a node dist/server.cjs recipe'))!.test;
    expect(boot('  1. Boot the compiled artifact (`node dist/server.cjs`) on an ephemeral test port (e.g., `PORT=3001`).')).toBe(true); // the old AGENTS.md recipe
    expect(boot('Boot `node dist/server.cjs` from scratch cwd with sanitized `.env`, `PORT=3001`')).toBe(true);
    expect(boot('cd "$D" && APEX_ENV_FILE=\'\' APEX_DB_PATH="$D/x.db" SIGNER_KEYPAIR_PATH="$D/none.json" node dist/server.cjs')).toBe(false);
    expect(files.some((f) => fs.readFileSync(f, 'utf8').split('\n').some((l) => BOOT_RECIPE.test(l)))).toBe(true); // AGENTS.md section 5 has one, so the rule is not matching nothing
    expect(host('SOLANA_RPC_URL=https://api.mainnet-beta.solana.com')).toBe(true);
    expect(host('JITO_BLOCK_ENGINE_URL=https://frankfurt.mainnet.block-engine.jito.wtf')).toBe(true);
    expect(host('JITO_BLOCK_ENGINE_URL=https://ny.mainnet.jito.wtf/api/v1')).toBe(true);
    expect(host('SOLANA_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/KEY')).toBe(true);
    expect(host('SOLANA_RPC_URL=https://solana-mainnet.quiknode.pro/KEY')).toBe(true);
    expect(host('use https://mainnet.solana.com for real trades')).toBe(true);
    expect(host('SOLANA_RPC_URL=https://api.solana.com')).toBe(true);
    expect(host('SOLANA_RPC_URL=https://api.devnet.solana.com')).toBe(false);
    expect(explorer('see https://solscan.io/account/abc')).toBe(true);
    expect(explorer('see solscan.io/account/abc')).toBe(true);
    expect(explorer('see https://solscan.io/account/abc?cluster=devnet')).toBe(false);
    expect(money('Set ALLOW_LIVE_REAL_MONEY_TRADING=true when ready for real-money execution')).toBe(true);
    expect(money('ALLOW_LIVE_REAL_MONEY_TRADING=true # only after a funded mainnet test')).toBe(true);
    expect(money('Only set ALLOW_LIVE_REAL_MONEY_TRADING=true when you are ready; it requires a key')).toBe(true);
    expect(money('  ALLOW_LIVE_REAL_MONEY_TRADING: "true"')).toBe(true);
    expect(money('| `ALLOW_LIVE_REAL_MONEY_TRADING` | true |')).toBe(true);
    expect(money('Set ALLOW_LIVE_REAL_MONEY_TRADING to true to go live')).toBe(true);
    expect(money('ALLOW_LIVE_REAL_MONEY_TRADING=1')).toBe(true);
    expect(money('the harness never sets ALLOW_LIVE_REAL_MONEY_TRADING=true')).toBe(false);
    expect(money('ALLOW_LIVE_REAL_MONEY_TRADING=true # never do this')).toBe(true);
    expect(money('ALLOW_LIVE_REAL_MONEY_TRADING="false"')).toBe(false);
    expect(cluster('ALLOWED_CLUSTER=mainnet-beta')).toBe(true);
    expect(cluster('ALLOWED_CLUSTER=mainnet-beta  # not tested yet')).toBe(true);
    expect(cluster('  ALLOWED_CLUSTER: mainnet-beta')).toBe(true);
    expect(cluster('Do not set ALLOWED_CLUSTER=mainnet-beta')).toBe(false);
    expect(cluster('ALLOWED_CLUSTER=devnet')).toBe(false);
    const [cold, importKey, transfer] = RULES.slice(4).map((r) => r.test);
    expect(cold('transfer all remaining SOL out of the trading keypair to a designated cold wallet')).toBe(true);
    expect(cold('Never use cold-storage or primary treasury wallets for automated execution.')).toBe(true);
    expect(cold('fund it only from the devnet faucet')).toBe(false);
    expect(importKey('Import your wallet with npm run signer:import')).toBe(true);
    expect(importKey('import an existing key from Phantom')).toBe(true);
    expect(importKey('npm run signer:import -- /path/to/throwaway-keypair.json')).toBe(false);
    expect(transfer('via standard CLI tools (`solana transfer`)')).toBe(true);
    expect(transfer('solana transfer --keypair k.json <addr> ALL')).toBe(true);
    expect(transfer('solana transfer --url mainnet-beta --keypair k.json <addr> ALL')).toBe(true);
    expect(transfer('solana transfer --url devnet --keypair k.json <addr> ALL')).toBe(false);
  });
});

