import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Long behaviour tests: the real server process against the in-process LiteSVM validator (real pump.fun binaries), several
 * minutes per file. They are opt-in so `npm test` stays fast and so a patch gate never waits on them:
 *
 *   npx vitest run -c vitest.long.config.ts          (or `npm run test:long` once the script exists)
 *
 * Everything else (hermetic env, network guard, in-memory DB for this process) is inherited from vitest.config.ts. The files are
 * named *.longtest.ts so the default config's `**\/*.test.ts` glob never picks them up.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tests/long/**/*.longtest.ts'],
      testTimeout: 300_000,
      hookTimeout: 300_000,
      fileParallelism: false,
    },
  })
);
