import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

const guard = path.resolve(process.cwd(), 'scripts/devnet_guard.cjs');
const run = (code: string) =>
  spawnSync(process.execPath, ['--require', guard, '-e', code], { encoding: 'utf8', timeout: 20_000 });

describe('R2: devnet_guard.cjs preload', () => {
  it('throws on fetch to a mainnet or jito.wtf URL and logs the attempt', () => {
    for (const url of ['https://api.mainnet-beta.solana.com', 'https://mainnet.block-engine.jito.wtf/api/v1/bundles']) {
      const r = run(`fetch(${JSON.stringify(url)}).then(()=>process.exit(3),e=>{console.log(e.message)})`);
      expect(r.stdout).toContain('DEVNET_GUARD');
      expect(r.stderr).toContain('BLOCKED');
    }
  });

  it('throws on https.request / http.get to a blocked host', () => {
    const r = run(
      `const h=require('https');const g=require('http');` +
        `for (const f of [()=>h.request('https://x.mainnet.example/'),()=>g.get('http://bundles.jito.wtf/')]) { try{f();console.log('NOT_BLOCKED')}catch(e){console.log(e.message)} }`
    );
    expect(r.stdout).not.toContain('NOT_BLOCKED');
    expect(r.stdout.match(/DEVNET_GUARD/g)).toHaveLength(2);
  });

  it('allows and logs a devnet URL attempt without connecting during the check', () => {
    const r = run(`try{require('http').request('http://127.0.0.1:9/').on('error',()=>{}).end()}catch(e){console.log('THROWN')}`);
    expect(r.stdout).not.toContain('THROWN');
    expect(r.stderr).toContain('allow');
  });
});
