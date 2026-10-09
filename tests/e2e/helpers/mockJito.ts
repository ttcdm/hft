export interface MockBundleRecord {
  bundleId: string;
  transactions: string[];
  submittedAt: number;
  inflightStatus: 'Pending' | 'Landed' | 'Failed' | 'Invalid';
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | 'Failed';
  slot: number;
  err?: any;
}

export class MockJitoEngine {
  private originalFetch: typeof globalThis.fetch | null = null;
  private bundles: Map<string, MockBundleRecord> = new Map();
  private tipFloorLamports: number = 100_000; // 0.0001 SOL
  private shouldFailSubmissions: boolean = false;
  private shouldFailProbe: boolean = false;
  private failureMessage: string = 'Simulated Jito Error';
  private mockUrl: string = 'https://mock-jito-engine.local';

  public setTipFloorLamports(lamports: number) {
    this.tipFloorLamports = lamports;
  }

  public setFailSubmissions(fail: boolean, message: string = 'Simulated Jito Error') {
    this.shouldFailSubmissions = fail;
    this.failureMessage = message;
  }

  public setFailProbe(fail: boolean) {
    this.shouldFailProbe = fail;
  }

  public registerBundle(record: MockBundleRecord) {
    this.bundles.set(record.bundleId, record);
  }

  public getBundle(bundleId: string): MockBundleRecord | undefined {
    return this.bundles.get(bundleId);
  }

  public updateBundleStatus(bundleId: string, updates: Partial<MockBundleRecord>) {
    const existing = this.bundles.get(bundleId);
    if (existing) {
      this.bundles.set(bundleId, { ...existing, ...updates });
    }
  }

  public clear() {
    this.bundles.clear();
    this.shouldFailSubmissions = false;
  }

  public async start(): Promise<string> {
    this.originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as any).url || '';

      // 1. Tip Floor Endpoint
      if (urlStr.includes('/api/v1/bundles/tip_floor') || urlStr.includes('/tip_floor')) {
        const tipSol = this.tipFloorLamports / 1e9;
        const payload = [
          {
            landed_tips_50th_percentile: tipSol,
            landed_tips_75th_percentile: tipSol * 1.5,
            landed_tips_95th_percentile: tipSol * 2.0,
            ema_landed_tips_50th_percentile: tipSol,
          },
        ];
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 2. Mock Jito Block Engine RPC Endpoints
      if (urlStr.includes(this.mockUrl) || urlStr.includes('jito.wtf') || urlStr.includes('/api/v1/')) {
        let bodyJson: any = {};
        try {
          if (typeof init?.body === 'string') {
            bodyJson = JSON.parse(init.body);
          }
        } catch {}

        const { method, params, id = 1 } = bodyJson;

        if (this.shouldFailSubmissions && method === 'sendBundle') {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id, error: { message: this.failureMessage } }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (method === 'getTipAccounts') {
          if (this.shouldFailProbe) {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'probe down' } }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id, result: ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (method === 'sendBundle') {
          const bundleId = `bundle_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          const txs = (params && params[0]) || [];
          const record: MockBundleRecord = {
            bundleId,
            transactions: txs,
            submittedAt: Date.now(),
            inflightStatus: 'Pending',
            confirmationStatus: 'confirmed',
            slot: 280000005,
          };
          this.bundles.set(bundleId, record);

          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id, result: bundleId }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (method === 'getInflightBundleStatuses') {
          const queryIds = Array.isArray(params?.[0]) ? params[0] : params || [];
          const result = queryIds.map((bid: string) => {
            const b = this.bundles.get(bid);
            if (!b) return null;
            return {
              bundle_id: b.bundleId,
              status: b.inflightStatus,
              landed_slot: b.inflightStatus === 'Landed' ? b.slot : undefined,
              err: b.err,
            };
          });

          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id, result: { value: result } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (method === 'getBundleStatuses') {
          const queryIds = Array.isArray(params?.[0]) ? params[0] : params || [];
          const result = queryIds.map((bid: string) => {
            const b = this.bundles.get(bid);
            if (!b) return null;
            return {
              bundle_id: b.bundleId,
              confirmation_status: b.confirmationStatus,
              slot: b.slot,
              err: b.err,
            };
          });

          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id, result: { value: result } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id, result: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (this.originalFetch) {
        return this.originalFetch(input, init);
      }
      return new Response('Not found', { status: 404 });
    };

    return this.mockUrl;
  }

  public getUrl(): string {
    return this.mockUrl;
  }

  public async stop(): Promise<void> {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }
}
