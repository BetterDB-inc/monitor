import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { BROKER_TOKEN_ISSUER, BROKER_TOKEN_TYPE, BrokerProvider } from '@betterdb/shared';

export interface BrokerTokenInput {
  email: string;
  name?: string;
  avatarUrl?: string;
  provider: BrokerProvider;
  providerId: string;
  aud: string;
  state: string;
}

const TOKEN_LIFETIME = '5m';

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

@Injectable()
export class BrokerSigningService {
  private readonly logger = new Logger(BrokerSigningService.name);
  private readonly privateKey: string;
  private readonly kid: string;

  constructor() {
    this.privateKey = (process.env.BROKER_SIGNING_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
    this.kid = process.env.BROKER_SIGNING_KID ?? '';
    if (this.isConfigured() === false) {
      this.logger.warn(
        'BROKER_SIGNING_PRIVATE_KEY / BROKER_SIGNING_KID not set - self-hosted broker sign-in is unavailable',
      );
    }
  }

  isConfigured(): boolean {
    return this.privateKey.length > 0 && this.kid.length > 0;
  }

  sign(input: BrokerTokenInput): string {
    if (this.isConfigured() === false) {
      throw new ServiceUnavailableException('Broker signing is not configured');
    }
    if (originOf(input.aud) !== input.aud) {
      throw new BadRequestException('aud must be a bare origin');
    }
    return jwt.sign(
      {
        typ: BROKER_TOKEN_TYPE,
        email: input.email.trim().toLowerCase(),
        name: input.name ?? null,
        avatarUrl: input.avatarUrl ?? null,
        provider: input.provider,
        providerId: input.providerId,
        state: input.state,
      },
      this.privateKey,
      {
        algorithm: 'RS256',
        expiresIn: TOKEN_LIFETIME,
        issuer: BROKER_TOKEN_ISSUER,
        audience: input.aud,
        keyid: this.kid,
      },
    );
  }
}
