import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

export interface WorkspaceTokenPayload {
  userId: string;
  email: string;
  tenantId: string;
  subdomain: string;
  role: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly privateKey: string;

  constructor() {
    this.privateKey = process.env.AUTH_PRIVATE_KEY || '';
    if (!this.privateKey) {
      this.logger.warn('AUTH_PRIVATE_KEY not set - workspace token signing will fail');
    }
  }

  generateWorkspaceToken(payload: WorkspaceTokenPayload): string {
    if (!this.privateKey) {
      throw new Error('AUTH_PRIVATE_KEY not configured');
    }

    return jwt.sign(payload, this.privateKey, {
      algorithm: 'RS256',
      expiresIn: '5m',
      issuer: 'betterdb-entitlement',
    });
  }
}
