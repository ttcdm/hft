import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isBundledServer, defaultBundledToProduction, useDevMiddleware } from '../server/system/runtimeMode';
import { scratchDir } from './helpers/liveServer';

/**
 * R5-14: `npm start` is `node dist/server.cjs` with no NODE_ENV, and server.ts then mounted the Vite dev middleware over the project root.
 * Now the bundle always runs as production. Real runtimeMode module; the last case bundles it with esbuild exactly as `npm run build`
 * bundles server.ts (cjs, packages external) and runs that bundle with NODE_ENV unset.
 */
describe('R5-14: the bundled server never runs the dev middleware', () => {
  it('a bundle with NODE_ENV unset (or development) becomes production and gets no dev middleware', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(defaultBundledToProduction(env, true)).toMatch(/NODE_ENV was unset; the bundled server .* production/);
    expect(env.NODE_ENV).toBe('production');
    const dev: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    defaultBundledToProduction(dev, true);
    expect(dev.NODE_ENV).toBe('production');
    expect(useDevMiddleware({}, true)).toBe(false);
    expect(useDevMiddleware({ NODE_ENV: 'development' }, true)).toBe(false);
  });

  it('tsx server.ts (npm run dev) keeps the dev middleware; production and test are left alone', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(defaultBundledToProduction(env, false)).toBeNull();
    expect(env.NODE_ENV).toBeUndefined();
    expect(useDevMiddleware({}, false)).toBe(true);
    expect(useDevMiddleware({ NODE_ENV: 'production' }, false)).toBe(false);
    const t: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    expect(defaultBundledToProduction(t, true)).toBeNull();
    expect(t.NODE_ENV).toBe('test');
    expect(isBundledServer()).toBe(false); // vitest runs the source, not the bundle
    expect(isBundledServer('/app/dist/server.cjs')).toBe(true);
  });

  it('in a real esbuild cjs bundle named server.cjs the check sees the bundle', () => {
    const dir = scratchDir('r514-');
    const entry = path.join(dir, 'entry.ts');
    fs.writeFileSync(entry, `import { isBundledServer, useDevMiddleware } from ${JSON.stringify(path.resolve('server/system/runtimeMode.ts'))};\nconsole.log(JSON.stringify({ b: isBundledServer(), dev: useDevMiddleware() }));\n`);
    const out = path.join(dir, 'server.cjs');
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=cjs', '--packages=external', `--outfile=${out}`, '--log-level=error']);
    const env = { ...process.env };
    delete env.NODE_ENV;
    delete env.VITEST;
    const res = JSON.parse(execFileSync(process.execPath, [out], { env, encoding: 'utf8' }).trim());
    expect(res).toEqual({ b: true, dev: false });
  });
});
