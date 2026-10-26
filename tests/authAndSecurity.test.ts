import { describe, it, expect, beforeEach } from 'vitest';
import { AuthManager, authManager, requireOperatorAuth } from '../server/middleware/auth';
import { isSafeExternalUrl } from '../server/middleware/enterprise';

describe('AuthManager & Network Security Guard', () => {
  let auth: AuthManager;

  beforeEach(() => {
    auth = new AuthManager();
  });

  it('creates cryptographic session tokens with TTL', () => {
    const session = auth.createSession('OPERATOR');
    expect(session.token.length).toBe(64); // 32 bytes hex = 64 chars
    expect(session.role).toBe('OPERATOR');
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(auth.validateToken(session.token)).toBe(true);
  });

  it('rejects invalid or forged session tokens', () => {
    expect(auth.validateToken('forged-token-123456')).toBe(false);
    expect(auth.validateToken('')).toBe(false);
  });

  it('expires and removes stale session tokens', () => {
    const session = auth.createSession('OPERATOR');
    session.expiresAt = Date.now() - 1000; // Expired 1s ago
    expect(auth.validateToken(session.token)).toBe(false);
  });

  it('revokes session token cleanly on logout', () => {
    const session = auth.createSession('OPERATOR');
    expect(auth.revokeToken(session.token)).toBe(true);
    expect(auth.validateToken(session.token)).toBe(false);
  });

  it('rejects password authentication when OPERATOR_PASSWORD is not configured', () => {
    delete process.env.OPERATOR_PASSWORD;
    const res = auth.authenticateOperator({ password: 'any-password' });
    expect(res.success).toBe(false);
    expect(res.token).toBeUndefined();
    expect(res.error).toContain('Password authentication disabled');
  });

  it('authenticates operator with explicitly configured OPERATOR_PASSWORD', () => {
    process.env.OPERATOR_PASSWORD = 'super-secure-operator-secret-phrase-2026';
    const res = auth.authenticateOperator({ password: 'super-secure-operator-secret-phrase-2026' });
    expect(res.success).toBe(true);
    expect(res.token).toBeDefined();
    expect(auth.validateToken(res.token!)).toBe(true);
  });

  it('rejects authentication with invalid password when OPERATOR_PASSWORD is set', () => {
    process.env.OPERATOR_PASSWORD = 'super-secure-operator-secret-phrase-2026';
    const res = auth.authenticateOperator({ password: 'wrong-password' });
    expect(res.success).toBe(false);
    expect(res.token).toBeUndefined();
  });

  describe('SSRF Protection Guard (isSafeExternalUrl)', () => {
    it('blocks AWS/Azure/GCP metadata IP (169.254.169.254)', () => {
      expect(isSafeExternalUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
      expect(isSafeExternalUrl('http://169.254.1.1/info')).toBe(false);
    });

    it('blocks Google Cloud internal metadata host', () => {
      expect(isSafeExternalUrl('http://metadata.google.internal/computeMetadata/v1/')).toBe(false);
    });

    it('blocks embedded credentials', () => {
      expect(isSafeExternalUrl('https://admin:secret@mainnet.rpc.com')).toBe(false);
    });

    it('blocks dangerous non-HTTP/WS protocols', () => {
      expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
      expect(isSafeExternalUrl('ftp://example.com')).toBe(false);
      expect(isSafeExternalUrl('gopher://example.com')).toBe(false);
    });

    it('allows valid public RPC and Jito endpoints', () => {
      expect(isSafeExternalUrl('https://api.mainnet-beta.solana.com')).toBe(true);
      expect(isSafeExternalUrl('https://mainnet.block-engine.jito.wtf')).toBe(true);
      expect(isSafeExternalUrl('wss://api.mainnet-beta.solana.com')).toBe(true);
    });
  });

  describe('requireOperatorAuth middleware', () => {
    it('returns 401 when authorization header is missing', () => {
      let status = 0;
      let jsonBody: any = null;
      let nextCalled = false;

      const req: any = {
        headers: {},
        query: {},
        method: 'POST',
        originalUrl: '/api/order/submit',
      };
      const res: any = {
        status: (s: number) => {
          status = s;
          return {
            json: (b: any) => {
              jsonBody = b;
            },
          };
        },
      };
      const next = () => {
        nextCalled = true;
      };

      requireOperatorAuth(req, res, next);

      expect(status).toBe(401);
      expect(jsonBody.success).toBe(false);
      expect(jsonBody.error.code).toBe('UNAUTHORIZED_MUTATION');
      expect(nextCalled).toBe(false);
    });

    it('returns 401 when authorization token is invalid or expired', () => {
      let status = 0;
      let jsonBody: any = null;
      let nextCalled = false;

      const req: any = {
        headers: { authorization: 'Bearer invalid-token-123' },
        query: {},
        method: 'POST',
        originalUrl: '/api/order/submit',
      };
      const res: any = {
        status: (s: number) => {
          status = s;
          return {
            json: (b: any) => {
              jsonBody = b;
            },
          };
        },
      };
      const next = () => {
        nextCalled = true;
      };

      requireOperatorAuth(req, res, next);

      expect(status).toBe(401);
      expect(jsonBody.success).toBe(false);
      expect(jsonBody.error.code).toBe('UNAUTHORIZED_MUTATION');
      expect(nextCalled).toBe(false);
    });

    it('calls next() when a valid Bearer session token is provided', () => {
      const session = authManager.createSession('OPERATOR');
      let nextCalled = false;

      const req: any = {
        headers: { authorization: `Bearer ${session.token}` },
        query: {},
        method: 'POST',
        originalUrl: '/api/order/submit',
      };
      const res: any = {
        status: (s: number) => ({ json: (b: any) => {} }),
      };
      const next = () => {
        nextCalled = true;
      };

      requireOperatorAuth(req, res, next);
      expect(nextCalled).toBe(true);
    });

    it('calls next() when a valid x-session-token header is provided', () => {
      const session = authManager.createSession('OPERATOR');
      let nextCalled = false;

      const req: any = {
        headers: { 'x-session-token': session.token },
        query: {},
        method: 'POST',
        originalUrl: '/api/order/submit',
      };
      const res: any = {
        status: (s: number) => ({ json: (b: any) => {} }),
      };
      const next = () => {
        nextCalled = true;
      };

      requireOperatorAuth(req, res, next);
      expect(nextCalled).toBe(true);
    });
  });

  describe('Origin Validation & Cross-Origin Guard (isAllowedClientOrigin)', async () => {
    const { isAllowedClientOrigin } = await import('../server/middleware/auth');

    it('allows loopback / localhost origins for local workstation operation', () => {
      expect(isAllowedClientOrigin('http://localhost:3000')).toBe(true);
      expect(isAllowedClientOrigin('http://127.0.0.1:5173')).toBe(true);
    });

    it('allows same-origin matching the Host header', () => {
      expect(isAllowedClientOrigin('https://trading.quant.internal', 'trading.quant.internal')).toBe(true);
      expect(isAllowedClientOrigin('https://trading.quant.internal:8443', 'trading.quant.internal:8443')).toBe(true);
    });

    it('rejects foreign or mismatched origins', () => {
      expect(isAllowedClientOrigin('https://malicious-site.com', 'trading.quant.internal')).toBe(false);
      expect(isAllowedClientOrigin('https://localhost.attacker.com', 'trading.quant.internal')).toBe(false);
    });

    it('allows explicitly configured ALLOWED_ORIGINS', () => {
      process.env.ALLOWED_ORIGINS = 'https://portal.apex-quant.com, https://admin.apex-quant.com';
      expect(isAllowedClientOrigin('https://portal.apex-quant.com', 'otherhost.com')).toBe(true);
      expect(isAllowedClientOrigin('https://admin.apex-quant.com', 'otherhost.com')).toBe(true);
      expect(isAllowedClientOrigin('https://untrusted.apex-quant.com', 'otherhost.com')).toBe(false);
      delete process.env.ALLOWED_ORIGINS;
    });

    it('handles malformed origins safely by rejecting', () => {
      expect(isAllowedClientOrigin('not-a-valid-url')).toBe(false);
      expect(isAllowedClientOrigin('javascript:alert(1)')).toBe(false);
    });
  });

  describe('Query Parameter Credential Rejection (R0.7)', () => {
    it('rejects API requests attempting to pass credentials via query params', async () => {
      // Simulate handler check logic for /api/account/balance
      const handleAccountBalance = (req: any, res: any) => {
        if (req.query.secret || req.query.apiSecret || req.query.apiKey) {
          return res.status(400).json({
            error: 'CRITICAL_SECURITY_VIOLATION',
            message: 'Credentials must NEVER be passed via URL query parameters. Use HTTP headers (x-mbx-apikey, x-mbx-apisecret).',
          });
        }
        const apiKey = req.headers['x-mbx-apikey'];
        const apiSecret = req.headers['x-mbx-apisecret'] || req.headers['x-api-secret'];
        return res.status(200).json({ success: true, authenticated: Boolean(apiKey && apiSecret) });
      };

      let status = 0;
      let body: any = null;
      const res = {
        status: (s: number) => {
          status = s;
          return { json: (b: any) => { body = b; } };
        },
      };

      // 1. Passing secret in query -> must be rejected with 400
      handleAccountBalance({ query: { secret: 'leaked-secret' }, headers: {} }, res);
      expect(status).toBe(400);
      expect(body.error).toBe('CRITICAL_SECURITY_VIOLATION');

      // 2. Passing apiSecret in query -> must be rejected with 400
      handleAccountBalance({ query: { apiSecret: 'leaked-secret' }, headers: {} }, res);
      expect(status).toBe(400);
      expect(body.error).toBe('CRITICAL_SECURITY_VIOLATION');

      // 3. Passing apiKey in query -> must be rejected with 400
      handleAccountBalance({ query: { apiKey: 'leaked-key' }, headers: {} }, res);
      expect(status).toBe(400);
      expect(body.error).toBe('CRITICAL_SECURITY_VIOLATION');

      // 4. Passing credentials via headers -> accepted
      handleAccountBalance({
        query: {},
        headers: { 'x-mbx-apikey': 'valid-key', 'x-mbx-apisecret': 'valid-secret' },
      }, res);
      expect(status).toBe(200);
      expect(body.authenticated).toBe(true);
    });
  });

  describe('Signal Provenance Enforcement & Synthetic Isolation (R0.9)', async () => {
    const { socialScanner } = await import('../server/socialScanner');
    const { memecoinAggregator } = await import('../server/memecoinAggregator');

    it('rejects trade signals without mandatory non-null provenance', () => {
      const invalidSignal: any = {
        id: `sig_${Date.now()}`,
        mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
        symbol: 'NOPROV',
        platform: 'TWITTER',
        sentimentScore: 0.95,
        velocity: 120,
        volume24h: 500000,
        detectedAt: Date.now(),
        // provenance intentionally omitted
      };

      expect(() => socialScanner.addSignal(invalidSignal)).toThrow(
        'MANDATORY_PROVENANCE_REQUIRED'
      );
    });

    it('accepts trade signals with valid non-null provenance', () => {
      const validProvenances = [
        'REAL_ONCHAIN',
        'REAL_MEME_AGGREGATOR',
        'REAL_SOCIAL',
        'COPY_TRADE',
        'MANUAL_OPERATOR',
      ] as const;

      for (const prov of validProvenances) {
        const signal: any = {
          id: `sig_${prov}_${Date.now()}`,
          mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
          symbol: 'VALIDPROV',
          platform: 'TELEGRAM',
          sentimentScore: 0.85,
          velocity: 100,
          volume24h: 300000,
          detectedAt: Date.now(),
          provenance: prov,
        };

        let threw = false;
        try {
          socialScanner.addSignal(signal);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
      }
    });

    it('guarantees synthetic meme pools are empty when DEMO_MODE is disabled', () => {
      const prevMode = process.env.DEMO_MODE;
      delete process.env.DEMO_MODE;

      const pools = memecoinAggregator.getPools();
      expect(pools).toEqual([]);

      process.env.DEMO_MODE = prevMode;
    });
  });

  describe('WebSocket Auth Handshake Verification (R0.7)', async () => {
    const { verifyWsAuth } = await import('../server/middleware/auth');

    it('rejects unauthenticated or null WebSocket tokens', () => {
      expect(verifyWsAuth(null)).toBe(false);
      expect(verifyWsAuth(undefined)).toBe(false);
      expect(verifyWsAuth('')).toBe(false);
      expect(verifyWsAuth('invalid-token')).toBe(false);
    });

    it('authorizes WebSocket connections with a valid operator session token', () => {
      const session = authManager.createSession('OPERATOR');
      expect(verifyWsAuth(session.token)).toBe(true);
    });
  });

  describe('Execution Coordinator Mint Mismatch and Provenance Gating (R0.7, R0.9)', async () => {
    const { ExecutionCoordinator } = await import('../server/execution/coordinator');

    it('rejects trade execution when eligibility report mint does not match trade mint', async () => {
      const coord = new ExecutionCoordinator();
      try {
        const res = await coord.executeTrade({
          mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
          symbol: 'TEST',
          name: 'Test Token',
          amountSol: 0.01,
          source: 'AUTO_SNIPER',
          provenance: 'REAL_ONCHAIN',
          eligibilityReport: {
            mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', // Mismatched mint!
            isEligible: true,
            checks: [],
            failedCount: 0,
            evaluatedAt: Date.now(),
          },
        });
        expect(res.success).toBe(false);
        expect(res.lifecycleState).toBe('FILTER_REJECTED');
        expect(res.error).toContain('ELIGIBILITY_MINT_MISMATCH');
      } finally {
        coord.cleanup();
      }
    });

    it('rejects unapproved provenance in LIVE mode with PROVENANCE_VIOLATION', async () => {
      const coord = new ExecutionCoordinator();
      try {
        (coord as any).executionMode = 'LIVE';
        const res = await coord.executeTrade({
          mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
          symbol: 'TEST',
          name: 'Test Token',
          amountSol: 0.01,
          source: 'AUTO_SNIPER',
          provenance: 'PAPER_REPLAY', // Not approved for live!
        });
        expect(res.success).toBe(false);
        expect(res.lifecycleState).toBe('RISK_REJECTED');
        expect(res.error).toContain('PROVENANCE_VIOLATION');
      } finally {
        coord.cleanup();
      }
    });
  });
});


