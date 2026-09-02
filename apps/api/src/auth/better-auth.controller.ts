import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { BETTER_AUTH, CLIENT_IP_HEADER, type BetterAuthInstance } from './better-auth.factory';
import { toWebHeaders } from './web-headers';

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

@Controller('auth')
export class BetterAuthController {
  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance) {}

  @All('*')
  async bridge(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const response = await this.auth.handler(this.toWebRequest(req));
    reply.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') {
        reply.header(key, value);
      }
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) {
      reply.header('set-cookie', cookies);
    }
    reply.send(await response.text());
  }

  private toWebRequest(req: FastifyRequest): Request {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url, `${req.protocol}://${host}`);
    const hasBody = BODYLESS_METHODS.has(req.method) === false && req.body !== undefined;
    const headers = toWebHeaders(req.headers);
    headers.set(CLIENT_IP_HEADER, req.ip);
    return new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
  }
}
