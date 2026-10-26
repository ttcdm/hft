/**
 * Wait for a signature the stand-in validator has withheld AFTER a given point.
 *
 * `localnet_stats.held` lists every signature withheld since the validator started, never cleared. A step that waited for "any held
 * signature" saw the previous step's (the (f) buy) at once and killed the app before its own sell had been sent (the 42/44 run at 208:
 * (g) reported the (f) buy's signature and the position stayed OPEN). Callers take `before = held.length` just before arming the hold and
 * wait for a signature beyond it.
 */
export async function waitForNewHeld(
  getHeld: () => Promise<string[]>,
  before: number,
  opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<string | null> {
  const { tries = 60, delayMs = 250, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = opts;
  for (let i = 0; i < tries; i++) {
    await sleep(delayMs);
    const held = await getHeld();
    if (held.length > before) return held[before];
  }
  return null;
}
