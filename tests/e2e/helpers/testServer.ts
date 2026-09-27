import express, { Express } from 'express';
import cors from 'cors';
import { AuthManager, isAllowedClientOrigin } from '../../../server/middleware/auth';
import {
  correlationIdMiddleware,
  securityHeadersMiddleware,
  rateLimiter,
  errorHandler,
} from '../../../server/middleware/enterprise';

export function createTestApp(authManager: AuthManager = new AuthManager()): Express {
  const app = express();

  app.use(correlationIdMiddleware);
  app.use(securityHeadersMiddleware);
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || isAllowedClientOrigin(origin)) {
          callback(null, true);
        } else {
          callback(new Error('CORS_ORIGIN_NOT_ALLOWED'));
        }
      },
      credentials: true,
    })
  );
  app.use(express.json());

  // Require Operator Auth middleware helper
  const requireAuth = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    const sessionTokenHeader = req.headers['x-session-token'];
    const token =
      (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null) || (typeof sessionTokenHeader === 'string' ? sessionTokenHeader : null);

    if (!token || !authManager.validateToken(token)) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED: Valid operator session token required.',
      });
    }
    next();
  };

  // Auth Endpoints
  app.post('/api/auth/login', (req, res) => {
    const { password } = req.body || {};
    const result = authManager.authenticateOperator({ password });
    if (!result.success) {
      return res.status(401).json(result);
    }
    res.json(result);
  });

  app.get('/api/auth/session', (req, res) => {
    const authHeader = req.headers.authorization;
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token || !authManager.validateToken(token)) {
      return res.status(401).json({ authenticated: false });
    }
    res.json({ authenticated: true, role: 'OPERATOR' });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    const authHeader = req.headers.authorization;
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    authManager.revokeToken(token);
    res.json({ success: true, message: 'Logged out' });
  });

  // Health Endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'OK',
      timestamp: Date.now(),
      liveReadiness: {
        ready: false,
        reasons: ['LIVE arming not enabled'],
      },
    });
  });

  // Query parameter credential rejection test
  app.use((req, res, next) => {
    if (req.query?.sessionToken || req.query?.token || req.query?.password || req.query?.key) {
      return res.status(400).json({
        success: false,
        error: 'CREDENTIALS_IN_QUERY_PARAM_FORBIDDEN: Sensitive credentials must not be passed in URL query parameters.',
      });
    }
    next();
  });

  app.use(errorHandler);

  return app;
}
