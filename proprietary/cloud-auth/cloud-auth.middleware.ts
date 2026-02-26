import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class CloudAuthMiddleware implements NestMiddleware {
  private sessionSecret: string;
  private tenantSchema: string;

  constructor() {
    this.sessionSecret = process.env.SESSION_SECRET || '';
    this.tenantSchema = process.env.DB_SCHEMA || '';
  }

  use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: () => void) {
    // Skip if not in cloud mode (should never happen since module is only loaded in CLOUD_MODE, but safety check)
    if (!process.env.CLOUD_MODE) {
      return next();
    }

    const path = (req.url || '').split('?')[0]; // Strip query params for path matching

    // Allow these paths through without auth
    if (
      path.startsWith('/auth/callback') ||
      path.startsWith('/api/auth/callback') ||
      path.startsWith('/auth/logout') ||
      path.startsWith('/api/auth/logout') ||
      path.startsWith('/api/health') ||
      path.startsWith('/health') ||
      path.startsWith('/agent/ws') ||
      path.startsWith('/api/agent/ws') ||
      path.startsWith('/assets/') ||
      path.startsWith('/favicon') ||
      path === '/symbol-white.svg'
    ) {
      return next();
    }

    // Check session cookie
    const sessionToken = this.getCookie(req, 'betterdb_session');
    if (sessionToken) {
      try {
        const payload = jwt.verify(sessionToken, this.sessionSecret, {
          algorithms: ['HS256'],
        }) as any;

        const expectedSchema = `tenant_${payload.subdomain.replace(/-/g, '_')}`;
        if (expectedSchema !== this.tenantSchema) {
          return this.redirectToLogin(res, req);
        }

        // Attach user to request for downstream use
        (req as any).cloudUser = payload;
        return next();
      } catch {
        // Invalid token, fall through to redirect
      }
    }

    return this.redirectToLogin(res, req);
  }

  private getCookie(req: FastifyRequest['raw'], name: string): string | undefined {
    const cookies = req.headers.cookie || '';
    const match = cookies.split(';').find((c) => c.trim().startsWith(`${name}=`));
    return match?.split('=')[1]?.trim();
  }

  private redirectToLogin(res: FastifyReply['raw'], req: FastifyRequest['raw']) {
    const host = req.headers.host || '';
    const redirectUrl = encodeURIComponent(`https://${host}`);
    res.writeHead(302, { Location: `https://betterdb.com/login?redirect=${redirectUrl}` });
    res.end();
  }
}
