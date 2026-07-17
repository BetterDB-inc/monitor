import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { randomUUID, createPublicKey } from 'crypto';
import { LICENSE_JWT_ISSUER, TIER_FEATURES, Tier } from '@betterdb/shared';

// Public keys the monitor fleet embeds and trusts, keyed by kid. The private
// key configured in prod MUST correspond to one of these (and to its declared
// kid) — otherwise every token we sign fails verification in the field and the
// whole fleet silently downgrades. Keep in sync with the monitor's
// proprietary/licenses/license-signing-keys.ts.
const KNOWN_PUBLIC_KEYS: Record<string, string> = {
  'lic-2026-01': `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2NLUmenXDZKNYNZG8Ozz
dRsNXs3SsTPNPnLW8ptrhcS0RdXFhoNXdLDX8/N/FST4wLNCOjkjcD5gf2BRKP8R
AE3sWwo7ogyNov2S3UI3c8nFcqIHpmhEnUvGfqLz9ZLV2vut5nOZodxCffFdhd/i
y0pg2PMW8n9JZNyXsigYxalbHIsSS8MfFaWNgYlO6bgx6u4Pfq+YTL/SoFjErZSW
EtZFlCz7ugaTjt86170m4J2bXTkowYObcJrmXWKboOSBzXt1bx0smhEryfCyzYl9
hWCt1MHnm1tCfMjKDsBLZGAxXRyCHLhTMdBnG7TO51FxOr6q/X/RegyXBNGI4QkV
XwIDAQAB
-----END PUBLIC KEY-----`,
};

function normalizePem(pem: string): string {
  // Compare by DER so header/whitespace/newline differences don't matter.
  return createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
}

export interface LicenseTokenInput {
  licenseId: string;
  tier: Tier;
  customer?: {
    id: string;
    name: string | null;
    email: string;
  };
  instanceLimit: number;
  mode: 'online' | 'offline';
}

export interface SignedLicenseToken {
  token: string;
  jti: string;
  kid: string;
  expiresAt: Date;
}

/**
 * Signs entitlement/license JWTs with a dedicated RS256 keypair, separate from
 * AUTH_PRIVATE_KEY so auth-key rotation never invalidates issued licenses.
 * The monitor verifies these tokens offline against its embedded public keys,
 * matching the signing key by the `kid` header.
 */
@Injectable()
export class LicenseSigningService {
  private readonly logger = new Logger(LicenseSigningService.name);
  private readonly privateKey: string;
  private readonly kid: string;
  private readonly keyUsable: boolean;

  constructor() {
    // Tolerate \n-escaped PEMs (dotenv/one-line secret stores) alongside real newlines
    this.privateKey = (process.env.LICENSE_SIGNING_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    this.kid = process.env.LICENSE_SIGNING_KID || '';
    if (!this.privateKey || !this.kid) {
      // In production a missing key would silently ship unsigned licensing
      // fleet-wide (monitors refuse unsigned paid grants) — fail the boot
      // instead so the misconfiguration is loud.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'LICENSE_SIGNING_PRIVATE_KEY / LICENSE_SIGNING_KID must be configured in production',
        );
      }
      this.logger.warn(
        'LICENSE_SIGNING_PRIVATE_KEY / LICENSE_SIGNING_KID not set - entitlement responses will not include signed tokens',
      );
      this.keyUsable = false;
      return;
    }

    // Prove the key actually signs at boot AND that it is the CORRECT key for
    // the declared kid — a valid-but-wrong key (staging key in prod, kid
    // mismatch) would otherwise pass a mere sign check, then every token fails
    // verification in the field and the fleet silently downgrades.
    try {
      jwt.sign({ bootCheck: true }, this.privateKey, { algorithm: 'RS256', expiresIn: '1m' });

      const expectedPub = KNOWN_PUBLIC_KEYS[this.kid];
      if (expectedPub) {
        const derivedPub = normalizePem(createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' }).toString());
        if (derivedPub !== normalizePem(expectedPub)) {
          throw new Error(
            `LICENSE_SIGNING_PRIVATE_KEY does not match the public key the fleet trusts for kid "${this.kid}"`,
          );
        }
      } else {
        // Unknown kid: monitors won't trust it. Warn loudly (fail in prod).
        const msg = `LICENSE_SIGNING_KID "${this.kid}" has no known fleet public key — monitors will reject its tokens`;
        if (process.env.NODE_ENV === 'production') throw new Error(msg);
        this.logger.warn(msg);
      }

      this.keyUsable = true;
    } catch (error) {
      const message = `LICENSE signing key check failed: ${(error as Error).message}`;
      if (process.env.NODE_ENV === 'production') {
        throw new Error(message);
      }
      this.logger.warn(message);
      this.keyUsable = false;
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.privateKey && this.kid && this.keyUsable);
  }

  signLicenseToken(input: LicenseTokenInput, expiresAt: Date): SignedLicenseToken {
    if (!this.isConfigured) {
      throw new Error('LICENSE_SIGNING_PRIVATE_KEY / LICENSE_SIGNING_KID not configured');
    }

    const jti = randomUUID();
    const token = jwt.sign(
      {
        tier: input.tier,
        features: TIER_FEATURES[input.tier],
        customer: input.customer,
        instanceLimit: input.instanceLimit,
        mode: input.mode,
        exp: Math.floor(expiresAt.getTime() / 1000),
      },
      this.privateKey,
      {
        algorithm: 'RS256',
        issuer: LICENSE_JWT_ISSUER,
        subject: input.licenseId,
        keyid: this.kid,
        jwtid: jti,
      },
    );

    return { token, jti, kid: this.kid, expiresAt };
  }
}
