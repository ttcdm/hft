import { watchWindow } from './watchWindow';

/**
 * R2-3 (haiku 2026-10-26): the holder gates (creator holding and top-10) counted only the creator's own wallet, so 40 creator-funded wallets
 * at 1.8% each (72% of the supply) read as 0% creator and 18% top-10 and passed LIVE eligibility. This classifies each large holder by what
 * the watch window's funder lookups learned about its owner (`WatchWindow.funderFacts`), for `fetchTokenHolderDistribution`:
 *   CREATOR          the owner is the creator
 *   CREATOR_CLUSTER  a SOL source of the owner, or of one of its sources (two hops), is the creator
 *   INDEPENDENT      the owner's whole short history was read, it has a source, every source's own funding was looked up (R13-4), and none
 *                    of the above
 *   UNKNOWN          the owner could not be read, was never looked up, its history was not read in full, or (R13-4) one of its sources was
 *                    never looked up, so the second hop cannot be ruled out
 * Fail closed: UNKNOWN is never treated as independent. The holder gate counts every UNKNOWN holder together as ONE holder in the top-10
 * concentration figure, and (R13-3) counts UNKNOWN holdings against the creator cap (pumpCurve.ts `fetchTokenHolderDistribution`).
 *
 * R13-4: the second hop needs the funder of the owner's funder. The watch window asks the funder lookup for it (`WATCH_FUNDER_HOP_MAX` per
 * mint) when a buyer's or seller's sources arrive; a hop that was not looked up makes the holder UNKNOWN, never INDEPENDENT. A source on the
 * operator's public-funder allowlist (APEX_PUBLIC_FUNDERS) needs no second hop.
 */
export type HolderClass = 'CREATOR' | 'CREATOR_CLUSTER' | 'INDEPENDENT' | 'UNKNOWN';

/** What is known of a wallet's funding: every SOL source found, and whether its history was read in full. null: never looked up. */
export interface HolderFunderSource {
  funderFacts(wallet: string): { sources: string[]; verified: boolean } | null;
  /** S4d: an allowlisted public funder (exchange hot wallet), whose own funding is not traced. Absent: none is. */
  isPublicFunder?(wallet: string): boolean;
}

/** The running app's funder knowledge: the watch window, fed by the funder lookup. */
export const defaultHolderFunderSource: HolderFunderSource = watchWindow;

export function classifyHolder(owner: string | null, insiders: ReadonlySet<string>, src: HolderFunderSource): HolderClass {
  if (!owner) return 'UNKNOWN';
  if (insiders.has(owner)) return 'CREATOR';
  const facts = src.funderFacts(owner);
  if (!facts) return 'UNKNOWN';
  let hopUnread = false;
  for (const s of facts.sources) {
    if (insiders.has(s)) return 'CREATOR_CLUSTER';
    if (src.isPublicFunder?.(s)) continue;
    const up = src.funderFacts(s);
    if (!up) { hopUnread = true; continue; } // R13-4: creator -> s -> owner is not ruled out
    if (up.sources.some((x) => insiders.has(x))) return 'CREATOR_CLUSTER';
  }
  return facts.verified && !hopUnread ? 'INDEPENDENT' : 'UNKNOWN';
}
