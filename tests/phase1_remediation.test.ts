import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AuthManager } from '../server/middleware/auth';
import { workstationDb, WorkstationDatabase } from '../server/db/database';
import { getOperatorSessionToken, setOperatorSessionToken, authFetch } from '../src/services/engineClient';

describe('Phase 1 Remediation Suite (B03, B04, B05, B15, B16, B18, B22)', () => {
  // =========================================================================
  // B15: Node Engines & Prerequisite Documentation
  // =========================================================================
  describe('B15: Node Engine & Prerequisite Verification', () => {
    it('package.json declares Node >= 22.5.0 and npm >= 10.0.0 in engines', () => {
      const pkgPath = path.join(process.cwd(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      expect(pkg.engines).toBeDefined();
      expect(pkg.engines.node).toBe('>=22.5.0');
      expect(pkg.engines.npm).toBe('>=10.0.0');
    });

    it('README.md states Node.js >= 22.5.0 is required for native node:sqlite', () => {
      const readmePath = path.join(process.cwd(), 'README.md');
      const readme = fs.readFileSync(readmePath, 'utf8');
      expect(readme).toContain('Node.js >= 22.5.0');
      expect(readme).toContain('node:sqlite');
    });
  });

  // =========================================================================
  // B16: Dynamic PORT and BIND_HOST Configuration
  // =========================================================================
  describe('B16: Dynamic Port & Host Binding in server.ts', () => {
    it('server.ts uses process.env.PORT and process.env.BIND_HOST', () => {
      const serverCode = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
      expect(serverCode).toContain('const PORT = parseInt(');
      expect(serverCode).toContain('process.env.PORT');
      // A1: BIND_HOST is resolved through resolveBindHost(), which reads process.env.BIND_HOST
      expect(serverCode).toContain('const BIND_HOST = bindResolution.host');
      expect(serverCode).toContain('server.listen(PORT, BIND_HOST');
    });
  });

  // =========================================================================
  // B04 & B05: Environment Standardization & Token Prominence
  // =========================================================================
  describe('B04 & B05: Environment Standardization & Token Banner', () => {
    it('.env.example standardizes on OPERATOR_AUTH_TOKEN and documents >= 16 chars', () => {
      const envExample = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
      expect(envExample).toContain('OPERATOR_AUTH_TOKEN=""');
      expect(envExample.includes('OPERATOR_SECRET=""')).toBe(false);
      expect(envExample).toContain('minimum 16 characters');
    });

    it('.env.example documents ALLOW_LIVE_REAL_MONEY_TRADING="false"', () => {
      const envExample = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
      expect(envExample).toContain('ALLOW_LIVE_REAL_MONEY_TRADING="false"');
    });

    it('.env.example documents SOLANA_RPC_URL, SOLANA_WS_URL, and JITO_DEFAULT_TIP_LAMPORTS=180000', () => {
      const envExample = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
      expect(envExample).toContain('SOLANA_RPC_URL=');
      expect(envExample).toContain('SOLANA_WS_URL=');
      expect(envExample).toContain('JITO_BLOCK_ENGINE_URL=');
      expect(envExample).toContain('JITO_DEFAULT_TIP_LAMPORTS=180000');
    });

    it('server/middleware/auth.ts prints a highlighted stdout banner when generating fallback token', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const origToken = process.env.OPERATOR_AUTH_TOKEN;
      delete process.env.OPERATOR_AUTH_TOKEN;

      const _auth = new AuthManager();
      expect(consoleSpy).toHaveBeenCalled();
      const logs = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logs).toContain('NO OPERATOR_AUTH_TOKEN CONFIGURED');
      expect(logs).toContain('GENERATED VOLATILE TOKEN');

      if (origToken) process.env.OPERATOR_AUTH_TOKEN = origToken;
      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // B03: Frontend Token Storage & Authorization Handshake
  // =========================================================================
  describe('B03: Frontend Authentication Service & Headers', () => {
    const mockStorage: Record<string, string> = {};

    beforeEach(() => {
      // Mock localStorage for node environment
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => mockStorage[k] || null,
        setItem: (k: string, v: string) => {
          mockStorage[k] = v;
        },
        removeItem: (k: string) => {
          delete mockStorage[k];
        },
        clear: () => {
          for (const k of Object.keys(mockStorage)) delete mockStorage[k];
        },
      });
      vi.stubGlobal('window', {
        localStorage: (globalThis as any).localStorage,
        location: { protocol: 'http:', host: 'localhost:3000' },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('getOperatorSessionToken reads token from localStorage first', async () => {
      const sampleToken = 'c0ffeec0ffeec0ffeec0ffeec0ffee12';
      setOperatorSessionToken(sampleToken);

      const token = await getOperatorSessionToken();
      expect(token).toBe(sampleToken);
      expect((globalThis as any).localStorage.getItem('apex_operator_token')).toBe(sampleToken);
    });

    it('authFetch attaches Authorization Bearer and x-session-token headers', async () => {
      const sampleToken = '1234567890abcdef1234567890abcdef';
      setOperatorSessionToken(sampleToken);

      let capturedHeaders: Headers | undefined;
      const fetchMock = vi.fn().mockImplementation((input: any, init: any) => {
        capturedHeaders = init?.headers;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      });
      vi.stubGlobal('fetch', fetchMock);

      await authFetch('/api/test/secure');
      expect(fetchMock).toHaveBeenCalled();
      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders?.get('authorization')).toBe(`Bearer ${sampleToken}`);
      expect(capturedHeaders?.get('x-session-token')).toBe(sampleToken);
    });
  });

  // =========================================================================
  // B22: Header Telemetry Clean Initialization
  // =========================================================================
  describe('B22: Header Initial Profit State', () => {
    it('Header.tsx initializes profit summary to $0.00 (0.0%) 0 Active without hardcoded +$4.22', () => {
      const headerCode = fs.readFileSync(path.join(process.cwd(), 'src/components/Header.tsx'), 'utf8');
      expect(headerCode.includes('totalPnLUsd: 4.22')).toBe(false);
      expect(headerCode.includes('totalPnLPct: 42.2')).toBe(false);
      expect(headerCode.includes('activeCount: 2')).toBe(false);
      expect(headerCode).toContain('{ totalPnLUsd: 0.0, totalPnLPct: 0.0, activeCount: 0 }');
    });
  });

  // =========================================================================
  // B18: Database Isolation During Tests
  // =========================================================================
  describe('B18: Test Database Isolation', () => {
    it('workstationDb uses in-memory or TEST_DB_PATH instead of apex_workstation.db', () => {
      expect(process.env.TEST_DB_PATH).toBeDefined();
      expect(process.env.TEST_DB_PATH).toBe(':memory:');

      // Writing a position to workstationDb during test execution
      const dummyPosId = `iso_test_${Date.now()}`;
      workstationDb.savePosition({
        id: dummyPosId,
        mint: '11111111111111111111111111111111',
        symbol: 'ISOTEST',
        name: 'Isolation Test',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000',
        costBasisLamports: 1000,
        entryPriceSol: 0.001,
        currentPriceSol: 0.001,
        currentValueSol: 0.001,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig',
        entrySlot: 1,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'PAPER',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      });

      const loaded = workstationDb.loadPositions('PAPER', 'OPEN');
      expect(loaded.some((p) => p.id === dummyPosId)).toBe(true);

      // Verify that if we check the disk file directly, the dummy position does not exist there
      const diskDb = new WorkstationDatabase(path.join(process.cwd(), 'apex_workstation.db'));
      const diskPositions = diskDb.loadPositions('PAPER', 'OPEN');
      expect(diskPositions.some((p) => p.id === dummyPosId)).toBe(false);
    });
  });
});
