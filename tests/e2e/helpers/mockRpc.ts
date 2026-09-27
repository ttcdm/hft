import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../../../server/solana/programs';

export interface MockAccountData {
  owner: PublicKey;
  lamports: number;
  data: Buffer;
  executable: boolean;
  rentEpoch?: number;
}

export class MockSolanaRpc {
  private accounts: Map<string, MockAccountData> = new Map();
  private currentSlot: number = 280000000;
  private signatureStatuses: Map<string, { confirmationStatus: string; slot: number; err: any }> = new Map();
  private submittedTransactions: Buffer[] = [];
  private simulateError: any = null;

  public setSlot(slot: number) {
    this.currentSlot = slot;
  }

  public advanceSlot(delta: number = 1) {
    this.currentSlot += delta;
  }

  public setAccount(pubkey: PublicKey | string, account: MockAccountData) {
    const key = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
    this.accounts.set(key, account);
  }

  public removeAccount(pubkey: PublicKey | string) {
    const key = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
    this.accounts.delete(key);
  }

  public setTokenAccount(pubkey: PublicKey | string, amountRaw: string | bigint = '0') {
    const key = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
    this.accounts.set(key, {
      owner: TOKEN_PROGRAM_ID,
      lamports: 2039280,
      data: Buffer.alloc(165),
      executable: false,
      tokenAmountRaw: amountRaw.toString(),
    } as any);
  }

  public setSignatureStatus(signature: string, status: { confirmationStatus: string; slot?: number; err?: any }) {
    this.signatureStatuses.set(signature, {
      confirmationStatus: status.confirmationStatus || 'confirmed',
      slot: status.slot || this.currentSlot,
      err: status.err || null,
    });
  }

  public setSimulateError(err: any) {
    this.simulateError = err;
  }

  public getSubmittedTransactions(): Buffer[] {
    return [...this.submittedTransactions];
  }

  public clear() {
    this.accounts.clear();
    this.signatureStatuses.clear();
    this.submittedTransactions = [];
    this.simulateError = null;
  }

  // Create a duck-typed Connection-compatible object
  public createConnection(): Connection {
    const conn = {
      rpcEndpoint: 'http://127.0.0.1:8899',
      commitment: 'confirmed',
      getSlot: async () => this.currentSlot,
      getAccountInfo: async (pubkey: PublicKey) => {
        const found = this.accounts.get(pubkey.toBase58());
        if (!found) return null;
        return {
          ...found,
          data: Buffer.from(found.data),
        };
      },
      getMultipleAccountsInfo: async (pubkeys: PublicKey[]) => {
        return pubkeys.map((pk) => {
          const found = this.accounts.get(pk.toBase58());
          if (!found) return null;
          return {
            ...found,
            data: Buffer.from(found.data),
          };
        });
      },
      sendRawTransaction: async (rawTx: Buffer | Uint8Array) => {
        const buf = Buffer.from(rawTx);
        this.submittedTransactions.push(buf);
        const sig = `mock_tx_sig_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        this.setSignatureStatus(sig, { confirmationStatus: 'confirmed', slot: this.currentSlot });
        return sig;
      },
      getSignatureStatuses: async (signatures: string[]) => {
        const value = signatures.map((sig) => {
          const st = this.signatureStatuses.get(sig);
          if (!st) {
            return null;
          }
          return {
            slot: st.slot,
            confirmations: 1,
            err: st.err,
            confirmationStatus: st.confirmationStatus,
          };
        });
        return { context: { slot: this.currentSlot }, value };
      },
      simulateTransaction: async (_tx: any) => {
        if (this.simulateError) {
          return {
            context: { slot: this.currentSlot },
            value: { err: this.simulateError, logs: ['Simulation failed'], unitsConsumed: 0 },
          };
        }
        return {
          context: { slot: this.currentSlot },
          value: { err: null, logs: ['Program return: success'], unitsConsumed: 35000 },
        };
      },
      getLatestBlockhash: async () => {
        return {
          blockhash: 'MockBlockhash11111111111111111111111111111111',
          lastValidBlockHeight: 290000000,
        };
      },
      getBalance: async (pubkey: PublicKey) => {
        const acc = this.accounts.get(pubkey.toBase58());
        return acc ? acc.lamports : 70_000_000; // 0.07 SOL default
      },
      getTransaction: async (signature: string) => {
        return {
          slot: this.currentSlot,
          meta: { fee: 5000, err: null },
          transaction: { signatures: [signature] },
        };
      },
      getTokenAccountBalance: async (pubkey: PublicKey) => {
        const acc = this.accounts.get(pubkey.toBase58());
        if (!acc) {
          throw new Error('TokenAccountNotFoundError');
        }
        const amountStr = (acc as any).tokenAmountRaw || '0';
        return {
          context: { slot: this.currentSlot },
          value: {
            amount: amountStr,
            decimals: 6,
            uiAmount: Number(amountStr) / 1e6,
            uiAmountString: (Number(amountStr) / 1e6).toString(),
          },
        };
      },
    };

    return conn as unknown as Connection;
  }
}
