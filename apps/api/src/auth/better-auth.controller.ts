import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { BETTER_AUTH, CLIENT_IP_HEADER, type BetterAuthInstance } from './better-auth.factory';
import { toWebHeaders } from './web-headers';

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);
const SIGN_UP_SUFFIX = '/sign-up/email';

@Controller('auth')
export class BetterAuthController {
  private signUpQueue: Promise<void> = Promise.resolve();

  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance) {}

  @All('*')
  async bridge(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const request = this.toWebRequest(req);
    const response = await this.dispatch(req.method, request);
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

  private dispatch(method: string, request: Request): Promise<Response> {
    if (this.isSignUp(method, request) === false) {
      return this.auth.handler(request);
    }
    const pending = this.signUpQueue.then(() => {
      return this.auth.handler(request);
    });
    this.signUpQueue = pending.then(
      () => {
        return undefined;
      },
      () => {
        return undefined;
      },
    );
    return pending;
  }

  private isSignUp(method: string, request: Request): boolean {
    if (method !== 'POST') {
      return false;
    }
    return new URL(request.url).pathname.endsWith(SIGN_UP_SUFFIX);
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
