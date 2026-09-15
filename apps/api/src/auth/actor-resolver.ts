import { Inject, Injectable, Optional } from '@nestjs/common';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';
import { Actor, WorkspaceRole } from '@betterdb/shared';
import { BETTER_AUTH, CLIENT_IP_HEADER, type BetterAuthInstance } from './better-auth.factory';
import { toWebHeaders } from './web-headers';
import { WORKSPACE_CONFIG, WorkspaceConfig } from './workspace-config';

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

@Injectable()
export class ActorResolver {
  private readonly auth: BetterAuthInstance | null;

  constructor(
    @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig,
    @Optional() @Inject(BETTER_AUTH) auth?: BetterAuthInstance | null,
  ) {
    this.auth = auth ?? null;
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
    });
    const setCookies = authHeaders.getSetCookie();
    if (session === null) {
      return { actor: null, setCookies };
    }
    return { actor: this.toActor(session.user as SessionUserShape), setCookies };
  }

  async resolveFromHeaders(headers: IncomingHttpHeaders, clientIp: string): Promise<Actor | null> {
    const { actor } = await this.resolveSessionFromHeaders(headers, clientIp);
    return actor;
  }

  async resolveFromUpgrade(request: IncomingMessage): Promise<Actor | null> {
    if (this.isReady() === false) {
      return null;
    }
    try {
      return await this.resolveFromHeaders(request.headers, request.socket.remoteAddress ?? '');
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
