import { Keypair, PublicKey } from '@solana/web3.js';
import { WatchWindow } from '../../server/signals/watchWindow';

/**
 * R13-3: an UNKNOWN holder (owner unread, or its funder never looked up) counts against the creator cap. Holder-gate tests about the other
 * figures (curve exclusion, top-10 maths, the creator's own ATA) give their fake RPC this: every token account it is asked about is owned by
 * a fresh wallet that the returned real WatchWindow knows as independent (its whole history read, funded by a wallet that was looked up too).
 * Only the RPC is faked; pass `ww` as fetchTokenHolderDistribution's holderFunders.
 */
export function withIndependentOwners<T extends object>(conn: T): { conn: T; ww: WatchWindow } {
  const ww = new WatchWindow({ publicFunders: [] });
  const owners = new Map<string, PublicKey>();
  const ownerOf = (account: PublicKey): PublicKey => {
    let o = owners.get(account.toBase58());
    if (!o) {
      o = Keypair.generate().publicKey;
      owners.set(account.toBase58(), o);
      const funder = Keypair.generate().publicKey.toBase58();
      ww.setFunder(o.toBase58(), funder);
      ww.setNoFunder(funder);
    }
    return o;
  };
  const getMultipleAccountsInfo = async (keys: PublicKey[]) =>
    keys.map((k) => { const d = Buffer.alloc(165); d.set(ownerOf(k).toBuffer(), 32); return { data: d }; });
  return { conn: Object.assign(Object.create(Object.getPrototypeOf(conn)), conn, { getMultipleAccountsInfo }) as T, ww };
}
