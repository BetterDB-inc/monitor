import { Injectable, Logger, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID, createHash } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { StoragePort } from '../../apps/api/src/common/interfaces/storage-port.interface';
import type { AgentToken, TokenType } from '@betterdb/shared';

@Injectable()
export class AgentTokensService {
  private readonly logger = new Logger(AgentTokensService.name);
  private readonly sessionSecret: string;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
  ) {
    this.sessionSecret = process.env.SESSION_SECRET || '';
  }

  async generateToken(name: string, type: TokenType = 'agent'): Promise<{ token: string; metadata: AgentToken }> {
    const id = randomUUID();
    const now = Date.now();
    const expiresAt = now + 365 * 24 * 60 * 60 * 1000; // 1 year

    const token = jwt.sign(
      {
        sub: id,
        type,
        name,
      },
      this.sessionSecret,
      { algorithm: 'HS256', expiresIn: '365d' },
    );

    const tokenHash = createHash('sha256').update(token).digest('hex');

    const metadata: AgentToken = {
      id,
      name,
      type,
      tokenHash,
      createdAt: now,
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    };

    await this.storage.saveAgentToken(metadata);
    this.logger.log(`Generated ${type} token: ${id} (${name})`);

    return { token, metadata };
  }

  async listTokens(type?: TokenType): Promise<AgentToken[]> {
    return this.storage.getAgentTokens(type);
  }

  async revokeToken(id: string): Promise<void> {
    const tokens = await this.storage.getAgentTokens();
    const token = tokens.find(t => t.id === id);
    if (!token) {
      throw new NotFoundException(`Agent token ${id} not found`);
    }
    await this.storage.revokeAgentToken(id);
    this.logger.log(`Revoked agent token: ${id}`);
  }

  async validateToken(rawToken: string, expectedType?: TokenType): Promise<{ valid: boolean; tokenId?: string; name?: string; type?: TokenType }> {
    try {
      const payload = jwt.verify(rawToken, this.sessionSecret, {
        algorithms: ['HS256'],
      }) as any;

      const tokenType = payload.type as TokenType;
      if (tokenType !== 'agent' && tokenType !== 'mcp') {
        return { valid: false };
      }
      if (expectedType && tokenType !== expectedType) {
        return { valid: false };
      }

      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const stored = await this.storage.getAgentTokenByHash(tokenHash);

      if (!stored || stored.revokedAt) {
        return { valid: false };
      }

      // Update last used
      await this.storage.updateAgentTokenLastUsed(stored.id);

      return { valid: true, tokenId: stored.id, name: stored.name, type: tokenType };
    } catch {
      return { valid: false };
    }
  }
}
