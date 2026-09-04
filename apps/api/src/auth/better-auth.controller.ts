import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '@betterdb/shared';
import { ActivityService, toActivityActor } from '../activity/activity.service';
import { ActorResolver } from './actor-resolver';
import { BETTER_AUTH, CLIENT_IP_HEADER, type BetterAuthInstance } from './better-auth.factory';
import { toWebHeaders } from './web-headers';

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);
const SIGN_UP_SUFFIX = '/sign-up/email';
const SIGN_IN_SUFFIX = '/sign-in/email';
const SIGN_OUT_SUFFIX = '/sign-out';

interface SignedInUser {
  id: string;
  email: string;
}

function parseSignedInUser(text: string): SignedInUser | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const user = (parsed as { user?: unknown }).user;
    if (typeof user !== 'object' || user === null) {
      return null;
    }
    const { id, email } = user as { id?: unknown; email?: unknown };
    if (typeof id !== 'string' || typeof email !== 'string') {
      return null;
    }
    return { id, email };
  } catch {
    return null;
  }
}

@Controller('auth')
export class BetterAuthController {
  private signUpQueue: Promise<void> = Promise.resolve();

  constructor(
    @Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance,
    private readonly activity: ActivityService,
    private readonly actors: ActorResolver,
  ) {}

  @All('*')
  async bridge(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const request = this.toWebRequest(req);
    const pathname = new URL(request.url).pathname;
    const signingOut = req.method === 'POST' && pathname.endsWith(SIGN_OUT_SUFFIX);
    const actorBefore = signingOut === true ? await this.currentActor(req) : null;
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
    const text = await response.text();
    reply.send(text);
    this.recordAuthEvent(req, pathname, response.status, text, actorBefore);
  }

  private async currentActor(req: FastifyRequest): Promise<Actor | null> {
    try {
      return await this.actors.resolveFromHeaders(req.headers, req.ip);
    } catch {
      return null;
    }
  }

  private recordAuthEvent(
    req: FastifyRequest,
    pathname: string,
    status: number,
    text: string,
    actorBefore: Actor | null,
  ): void {
    if (req.method !== 'POST' || status !== 200) {
      return;
    }
    const method = this.loginMethod(pathname);
    if (method !== null) {
      const user = parseSignedInUser(text);
      if (user === null) {
        return;
      }
      void this.activity.record({
        actor: { userId: user.id, email: user.email, via: 'session', tokenId: null },
        action: 'auth.login',
        statusCode: status,
        ip: req.ip,
        details: { method },
      });
      return;
    }
    if (pathname.endsWith(SIGN_OUT_SUFFIX) === true && actorBefore !== null) {
      void this.activity.record({
        actor: toActivityActor(actorBefore),
        action: 'auth.logout',
        statusCode: status,
        ip: req.ip,
      });
    }
  }

  private loginMethod(pathname: string): 'password' | 'register' | null {
    if (pathname.endsWith(SIGN_IN_SUFFIX) === true) {
      return 'password';
    }
    if (pathname.endsWith(SIGN_UP_SUFFIX) === true) {
      return 'register';
    }
    return null;
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
    const host = req.host === '' ? 'localhost' : req.host;
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
