import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createPrivateKey, createPublicKey } from 'crypto';
import * as jwt from 'jsonwebtoken';
import {
  BROKER_SIGNING_PUBLIC_KEYS,
  BROKER_TOKEN_ISSUER,
  BROKER_TOKEN_TYPE,
  BrokerProvider,
} from '@betterdb/shared';

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

function normalizePem(pem: string): string {
  return createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
}

@Injectable()
export class BrokerSigningService {
  private readonly logger = new Logger(BrokerSigningService.name);
  private readonly privateKey: string;
  private readonly kid: string;
  private readonly keyUsable: boolean;

  constructor() {
    this.privateKey = (process.env.BROKER_SIGNING_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
    this.kid = process.env.BROKER_SIGNING_KID ?? '';

    if (this.privateKey.length === 0 || this.kid.length === 0) {
      this.logger.warn(
        'BROKER_SIGNING_PRIVATE_KEY / BROKER_SIGNING_KID not set - self-hosted broker sign-in is unavailable',
      );
      this.keyUsable = false;
      return;
    }

    try {
      const privateKeyObject = createPrivateKey(this.privateKey);
      if (privateKeyObject.asymmetricKeyType !== 'rsa') {
        throw new Error('BROKER_SIGNING_PRIVATE_KEY must be an RSA key');
      }

      const expectedPublicKey = BROKER_SIGNING_PUBLIC_KEYS[this.kid];
      if (expectedPublicKey !== undefined) {
        const derivedPublicKey = normalizePem(
          createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' }).toString(),
        );
        if (derivedPublicKey !== normalizePem(expectedPublicKey)) {
          throw new Error(
            `BROKER_SIGNING_PRIVATE_KEY does not match the public key trusted for kid "${this.kid}"`,
          );
        }
      }

      this.keyUsable = true;
    } catch (error) {
      const message = `BROKER signing key check failed: ${(error as Error).message}`;
      if (process.env.NODE_ENV === 'production') {
        throw new Error(message);
      }
      this.logger.warn(message);
      this.keyUsable = false;
    }
  }

  isConfigured(): boolean {
    return this.privateKey.length > 0 && this.kid.length > 0 && this.keyUsable;
  }

  sign(input: BrokerTokenInput): string {
    if (this.isConfigured() === false) {
      throw new ServiceUnavailableException('Broker signing is not configured');
    }
    if (originOf(input.aud) !== input.aud) {
      throw new BadRequestException('aud must be a bare origin');
    }

    const email = input.email.trim().toLowerCase();
    const token = jwt.sign(
      {
        typ: BROKER_TOKEN_TYPE,
        email,
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

    const emailHash = createHash('sha256').update(email).digest('hex').slice(0, 12);
    this.logger.log(
      `Signed broker token aud=${input.aud} provider=${input.provider} kid=${this.kid} email=${emailHash}`,
    );

    return token;
  }
}
