import { Inject, Injectable, Optional } from '@nestjs/common';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';
import { Actor, WorkspaceRole } from '@betterdb/shared';
import { PersonalTokenService } from '../workspace/personal-token.service';
import { BETTER_AUTH, CLIENT_IP_HEADER, type BetterAuthInstance } from './better-auth.factory';
import { toWebHeaders } from './web-headers';
import { WORKSPACE_CONFIG, WorkspaceConfig } from './workspace-config';

const BEARER_SCHEME = 'bearer ';

interface SessionUserShape {
  id: string;
  email: string;
  role?: unknown;
  isOwner?: unknown;
}

export interface SessionResolution {
  actor: Actor | null;
  setCookies: string[];
}

export function bearerToken(headers: IncomingHttpHeaders): string | null {
  const value = headers.authorization;
  if (typeof value !== 'string') {
    return null;
  }
  if (value.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) {
    return null;
  }
  const token = value.slice(BEARER_SCHEME.length).trim();
  if (token.length === 0) {
    return null;
  }
  return token;
}

@Injectable()
export class ActorResolver {
  private readonly auth: BetterAuthInstance | null;
  private readonly tokens: PersonalTokenService | null;

  constructor(
    @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig,
    @Optional() @Inject(BETTER_AUTH) auth?: BetterAuthInstance | null,
    @Optional() @Inject(PersonalTokenService) tokens?: PersonalTokenService | null,
  ) {
    this.auth = auth ?? null;
    this.tokens = tokens ?? null;
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  isReady(): boolean {
    return this.auth !== null;
  }

  enforcesMemberReadOnly(): boolean {
    return true;
  }

  async resolveSessionFromHeaders(
    headers: IncomingHttpHeaders,
    clientIp: string,
  ): Promise<SessionResolution> {
    if (this.auth === null) {
      return { actor: null, setCookies: [] };
    }
    const webHeaders = toWebHeaders(headers);
    webHeaders.set(CLIENT_IP_HEADER, clientIp);
    const { headers: authHeaders, response: session } = await this.auth.api.getSession({
      headers: webHeaders,
      returnHeaders: true,
      query: { disableCookieCache: true },
    });
    const setCookies = authHeaders.getSetCookie();
    if (session === null) {
      return { actor: null, setCookies };
    }
    return { actor: this.toActor(session.user as SessionUserShape), setCookies };
  }

  async resolveFromHeaders(headers: IncomingHttpHeaders, clientIp: string): Promise<Actor | null> {
    const { actor } = await this.resolveSessionFromHeaders(headers, clientIp);
    if (actor !== null) {
      return actor;
    }
    return this.resolveBearer(headers);
  }

  async resolveBearer(headers: IncomingHttpHeaders): Promise<Actor | null> {
    if (this.tokens === null) {
      return null;
    }
    const raw = bearerToken(headers);
    if (raw === null) {
      return null;
    }
    return this.tokens.resolveActor(raw);
  }

  async resolveFromUpgrade(request: IncomingMessage): Promise<Actor | null> {
    if (this.isReady() === false) {
      return null;
    }
    try {
      const { actor } = await this.resolveSessionFromHeaders(
        request.headers,
        request.socket.remoteAddress ?? '',
      );
      return actor;
    } catch {
      return null;
    }
  }

  private toActor(user: SessionUserShape): Actor {
    const role: WorkspaceRole = user.role === 'admin' ? 'admin' : 'member';
    return {
      userId: user.id,
      email: user.email,
      role,
      isOwner: user.isOwner === true,
      via: 'session',
      tokenId: null,
    };
  }
}
