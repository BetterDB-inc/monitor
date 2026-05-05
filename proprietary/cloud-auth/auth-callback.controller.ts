import { Controller, Get, Query, Req, Res, BadRequestException } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import * as jwt from 'jsonwebtoken';

@Controller('auth')
export class CloudAuthCallbackController {
  private publicKey: string;
  private sessionSecret: string;
  private tenantSchema: string;

  constructor() {
    this.publicKey = process.env.AUTH_PUBLIC_KEY || '';
    this.sessionSecret = process.env.SESSION_SECRET || '';
    this.tenantSchema = process.env.DB_SCHEMA || '';
  }

  private isDemoHost(req: FastifyRequest): boolean {
    const demoHost = process.env.DEMO_HOSTNAME;
    if (!demoHost) return false;
    return (req.headers.host || '') === demoHost;
  }

  /**
   * Returns the Domain cookie attribute for non-demo hosts only.
   * On the demo hostname we intentionally omit Domain so the session
   * cookie is scoped to demo.app.betterdb.com exclusively — this prevents
   * cross-workspace SESSION_SECRET verification failures (each pod has its
   * own secret; a cookie signed by one pod cannot be verified by another).
   */
  private cookieAttrs(req: FastifyRequest): string {
    if (this.isDemoHost(req)) return '';
    const domain = process.env.COOKIE_DOMAIN;
    return domain ? `Domain=${domain}; ` : '';
  }

  @Get('logout')
  handleLogout(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    reply.header(
      'Set-Cookie',
      `betterdb_session=; Path=/; ${this.cookieAttrs(request)}HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    );
    reply.status(302).redirect('https://betterdb.com');
  }

  @Get('callback')
  handleCallback(@Req() request: FastifyRequest, @Query('token') token: string, @Res() reply: FastifyReply) {
    if (!token) {
      throw new BadRequestException('Missing token');
    }

    try {
      // Verify the handoff token using the public key (RS256)
      const payload = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
        issuer: 'betterdb-entitlement',
      }) as any;

      // Verify this token is for THIS tenant (skip check on demo hostname)
      const expectedSchema = `tenant_${payload.subdomain.replace(/-/g, '_')}`;
      if (!this.isDemoHost(request) && expectedSchema !== this.tenantSchema) {
        throw new BadRequestException('Token not valid for this workspace');
      }

      // Sign a new session cookie with HS256 using SESSION_SECRET (7 days)
      const sessionToken = jwt.sign(
        {
          userId: payload.userId,
          email: payload.email,
          tenantId: payload.tenantId,
          subdomain: payload.subdomain,
          role: payload.role,
        },
        this.sessionSecret,
        { algorithm: 'HS256', expiresIn: '7d' }
      );

      // Set session cookie (domain-scoped on normal workspaces; host-only on demo)
      reply.header(
        'Set-Cookie',
        `betterdb_session=${sessionToken}; Path=/; ${this.cookieAttrs(request)}HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`
      );

      reply.status(302).redirect('/');
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid or expired token');
    }
  }
}
