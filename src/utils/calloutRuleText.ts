/**
 * S180: what the "confluence" rule on the callouts screen really does (server/pumpfunService.ts, evaluateAutoSnipeTriggers).
 * A callout counts as confluence when the token is both on the pump.fun velocity feed and on DexScreener's boosted list
 * (confluenceCount >= 2). The rule only matters while the Auto controller is not OFF.
 */
/** Equal to the server's MIN_CONFLUENCE_SCORE (a test pins them together; the client must not import server code). */
export const CONFLUENCE_RULE_MIN_SCORE = 70;
export const CONFLUENCE_RULE_LABEL = 'Also snipe on confluence';
export const CONFLUENCE_RULE_NOTE =
  `On: a callout that is on both the pump.fun velocity feed and DexScreener's boosted list, and scores ${CONFLUENCE_RULE_MIN_SCORE}+ on the confluence engine (70 by default; the Auto panel's confluence threshold changes it for the whole app), may be submitted even when its caller's stats are below the thresholds above. Submissions also must pass the same score at execution. Off: only the caller thresholds can trigger, and the score is not forced at execution. Nothing runs unless the Auto panel is not OFF.`;

/**
 * 3H (A7): what the whole rules form does, in one place, for the screen and for KNOWN_RISKS section 6. The screen said "no code acts on
 * them" while KNOWN_RISKS called them live; both were wrong in a different way. evaluateAutoSnipeTriggers does read them while Auto is not
 * OFF, but a callout only matches as INSTANT_SNIPE, which needs the DexScreener boost list (mainnet data), and the controller then drops any
 * mint the watch window has not released.
 */
export const CALLOUT_RULES_SCOPE_NOTE =
  'While the Auto panel is not OFF, the server checks these rules against each callout and submits a match to the Auto controller as a candidate. A callout can only match when it is marked INSTANT_SNIPE, which needs the token on the DexScreener paid-boost list: that is mainnet data, so on devnet and localnet these rules never match. The controller then buys only a mint the watch window has released, so a match adds a candidate and never skips the watch window. Saving keeps the rules in server memory until the next restart.';
