import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class CloudAuthGuardImpl implements CanActivate {
  private publicKey: string;
  private sessionSecret: string;
  private tenantSchema: string;

  constructor() {
    this.publicKey = process.env.AUTH_PUBLIC_KEY || '';
    this.sessionSecret = process.env.SESSION_SECRET || '';
    this.tenantSchema = process.env.DB_SCHEMA || '';
  }

  canActivate(context: ExecutionContext): boolean {
    // Not in cloud mode — allow everything
    if (!process.env.CLOUD_MODE) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const path = request.url;

    // Skip auth for callback route, logout route, health checks, agent WebSocket, and static assets
    if (path.startsWith('/auth/callback') ||
      path.startsWith('/api/auth/callback') ||
      path.startsWith('/auth/logout') ||
      path.startsWith('/api/auth/logout') ||
      path.startsWith('/api/health') ||
      path.startsWith('/health') ||
      path.startsWith('/agent/ws') ||
      path.startsWith('/api/agent/ws') ||
      path.startsWith('/assets/') ||
      path.startsWith('/favicon')) {
      return true;
    }

    // Check session cookie
    const sessionToken = this.getCookie(request, 'betterdb_session');
    if (sessionToken) {
      try {
        const payload = jwt.verify(sessionToken, this.sessionSecret, {
          algorithms: ['HS256'],
        }) as any;

        // Verify tenant matches
        const expectedSchema = `tenant_${payload.subdomain.replace(/-/g, '_')}`;
        if (expectedSchema !== this.tenantSchema) {
          this.redirectToLogin(reply, request);
          return false;
        }

        // Attach user to request
        (request as any).cloudUser = payload;
        return true;
      } catch {
        // Invalid/expired cookie — fall through to redirect
      }
    }

    // No valid session — redirect to login
    this.redirectToLogin(reply, request);
    return false;
  }

  private getCookie(request: FastifyRequest, name: string): string | undefined {
    const cookies = request.headers.cookie || '';
    const match = cookies.split(';').find((c: string) => c.trim().startsWith(`${name}=`));
    return match?.split('=')[1]?.trim();
  }

  private redirectToLogin(reply: FastifyReply, request: FastifyRequest) {
    const host = request.headers.host || '';
    const redirectUrl = encodeURIComponent(`https://${host}`);
    reply.redirect(`https://betterdb.com/login?redirect=${redirectUrl}`);
  }
}
