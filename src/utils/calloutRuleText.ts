/**
 * S180: what the "confluence" rule on the callouts screen really does (server/pumpfunService.ts, evaluateAutoSnipeTriggers).
 * A callout counts as confluence when the token is both on the pump.fun velocity feed and on DexScreener's boosted list
 * (confluenceCount >= 2). The rule only matters while the Auto controller is not OFF.
 */
/** Equal to the server's MIN_CONFLUENCE_SCORE (a test pins them together; the client must not import server code). */
export const CONFLUENCE_RULE_MIN_SCORE = 70;
export const CONFLUENCE_RULE_LABEL = 'Also snipe on confluence';
export const CONFLUENCE_RULE_NOTE =
  `On: a callout that is on both the pump.fun velocity feed and DexScreener's boosted list, and scores ${CONFLUENCE_RULE_MIN_SCORE}+ on the confluence engine, may be submitted even when its caller's stats are below the thresholds above. Submissions also must pass the ${CONFLUENCE_RULE_MIN_SCORE} score at execution. Off: only the caller thresholds can trigger, and the score is not forced at execution. Nothing runs unless the Auto panel is not OFF.`;
