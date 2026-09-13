import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Actor, AgentToken, TokenType } from '@betterdb/shared';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { MemberService } from './member.service';

export const PERSONAL_TOKEN_PREFIX = 'bdb_mcp_';
export const PERSONAL_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const TOKEN_NOT_FOUND_MESSAGE = 'Token not found';

const TOKEN_BYTES = 32;

export interface GeneratedPersonalToken {
  token: string;
  metadata: AgentToken;
}

export interface RevokePersonalTokenResult {
  token: AgentToken;
  changed: boolean;
}

export interface PersonalTokenView {
  id: string;
  name: string;
  type: TokenType;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  userId: string | null;
  ownerEmail: string | null;
}

export function hashPersonalToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function toPersonalTokenView(token: AgentToken, emails: Map<string, string>): PersonalTokenView {
  return {
    id: token.id,
    name: token.name,
    type: token.type,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    userId: token.userId,
    ownerEmail: token.userId === null ? null : (emails.get(token.userId) ?? null),
  };
}

@Injectable()
export class PersonalTokenService {
  private readonly logger = new Logger(PersonalTokenService.name);

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly members: MemberService,
  ) {}

  async generate(name: string, owner: Actor): Promise<GeneratedPersonalToken> {
    const token = `${PERSONAL_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    const now = Date.now();
    const metadata: AgentToken = {
      id: randomUUID(),
      name,
      type: 'mcp',
      tokenHash: hashPersonalToken(token),
      createdAt: now,
      expiresAt: now + PERSONAL_TOKEN_TTL_MS,
      revokedAt: null,
      lastUsedAt: null,
      userId: owner.userId,
    };
    await this.storage.saveAgentToken(metadata);
    return { token, metadata };
  }

  async list(viewer: Actor): Promise<PersonalTokenView[]> {
    const tokens = await this.storage.getAgentTokens('mcp');
    const visible = tokens.filter((token) => {
      return this.canManage(viewer, token);
    });
    const emails = await this.ownerEmails();
    return visible.map((token) => {
      return toPersonalTokenView(token, emails);
    });
  }

  async revoke(id: string, actor: Actor): Promise<RevokePersonalTokenResult> {
    const tokens = await this.storage.getAgentTokens('mcp');
    const token = tokens.find((candidate) => {
      return candidate.id === id;
    });
    if (token === undefined || this.canManage(actor, token) === false) {
      throw new NotFoundException(TOKEN_NOT_FOUND_MESSAGE);
    }
    if (token.revokedAt !== null) {
      return { token, changed: false };
    }
    await this.storage.revokeAgentToken(id);
    return { token, changed: true };
  }

  async resolveActor(raw: string): Promise<Actor | null> {
    if (raw.startsWith(PERSONAL_TOKEN_PREFIX) === false) {
      return null;
    }
    const token = await this.storage.getAgentTokenByHash(hashPersonalToken(raw));
    if (token === null || token.type !== 'mcp' || token.userId === null) {
      return null;
    }
    if (token.revokedAt !== null || token.expiresAt <= Date.now()) {
      return null;
    }
    const owner = await this.members.findById(token.userId);
    if (owner === null) {
      return null;
    }
    try {
      await this.storage.updateAgentTokenLastUsed(token.id);
    } catch (error) {
      this.logger.warn(`Failed to update lastUsedAt for token ${token.id}: ${String(error)}`);
    }
    return {
      userId: owner.id,
      email: owner.email,
      role: owner.role,
      isOwner: owner.isOwner,
      via: 'token',
      tokenId: token.id,
    };
  }

  private canManage(actor: Actor, token: AgentToken): boolean {
    if (actor.role === 'admin') {
      return true;
    }
    return token.userId === actor.userId;
  }

  private async ownerEmails(): Promise<Map<string, string>> {
    const members = await this.members.list();
    return new Map(
      members.map((member): [string, string] => {
        return [member.id, member.email];
      }),
    );
  }
}
