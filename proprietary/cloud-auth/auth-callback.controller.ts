import { Controller, Get, Query, Res, BadRequestException } from '@nestjs/common';
import { FastifyReply } from 'fastify';
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

  @Get('logout')
  handleLogout(@Res() reply: FastifyReply) {
    reply.header(
      'Set-Cookie',
      'betterdb_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    );
    reply.status(302).redirect('https://betterdb.com');
  }

  @Get('callback')
  handleCallback(@Query('token') token: string, @Res() reply: FastifyReply) {
    if (!token) {
      throw new BadRequestException('Missing token');
    }

    try {
      // Verify the handoff token using the public key (RS256)
      const payload = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
        issuer: 'betterdb-entitlement',
      }) as any;

      // Verify this token is for THIS tenant
      const expectedSchema = `tenant_${payload.subdomain.replace(/-/g, '_')}`;
      if (expectedSchema !== this.tenantSchema) {
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

      // Set cookie scoped to this subdomain
      reply.header(
        'Set-Cookie',
        `betterdb_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`
      );

      reply.status(302).redirect('/');
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid or expired token');
    }
  }
}
