import { vi } from 'vitest';
import { autoSnipeController, AutoMode } from '../../server/auto/controller';

/** Put the real auto-snipe controller into a mode for a test (the env flag is a controller input). */
export async function setAutoMode(mode: AutoMode): Promise<void> {
  vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
  const r = await autoSnipeController.setMode(mode);
  if (!r.ok) throw new Error(`test setup: could not set auto mode ${mode}: ${r.error}`);
}

export async function resetAuto(): Promise<void> {
  await autoSnipeController.setMode('OFF');
}
