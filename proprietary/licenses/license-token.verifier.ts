import * as jwt from 'jsonwebtoken';
import { Tier, TIER_FEATURES, LICENSE_JWT_ISSUER } from './types';
import type { EntitlementResponse, LicenseTokenClaims } from './types';
import { LICENSE_SIGNING_PUBLIC_KEYS } from './license-signing-keys';

export class LicenseTokenError extends Error {}

function isValidTier(value: unknown): value is Tier {
  return typeof value === 'string' && Object.values(Tier).includes(value as Tier);
}

/**
 * Verify a signed license/entitlement token fully offline against the
 * embedded public keys. Throws LicenseTokenError with a user-presentable
 * message on any failure; never trusts unverified payload data.
 */
export function verifyLicenseToken(
  token: string,
  keys: Record<string, string> = LICENSE_SIGNING_PUBLIC_KEYS,
): LicenseTokenClaims {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded.payload === 'string') {
    throw new LicenseTokenError('Malformed license token');
  }

  const kid = decoded.header.kid;
  // Own-property check: a bracket lookup would resolve inherited keys like
  // "__proto__"/"constructor" to truthy Object.prototype members, turning the
  // clean "unknown key — upgrade" message into a confusing internal error.
  const publicKey =
    kid && Object.prototype.hasOwnProperty.call(keys, kid) ? keys[kid] : undefined;
  if (!publicKey) {
    throw new LicenseTokenError(
      `License token was signed with an unknown key (${kid ?? 'no kid'}) — upgrade BetterDB Monitor to a release that includes it`,
    );
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: LICENSE_JWT_ISSUER,
    }) as jwt.JwtPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new LicenseTokenError('License token has expired — download a fresh one from your account page');
    }
    throw new LicenseTokenError(`License token verification failed: ${(error as Error).message}`);
  }

  if (!payload.sub || typeof payload.exp !== 'number') {
    throw new LicenseTokenError('License token is missing required claims');
  }
  if (!isValidTier(payload.tier)) {
    throw new LicenseTokenError('License token carries an unknown tier');
  }
  if (payload.mode !== 'online' && payload.mode !== 'offline') {
    throw new LicenseTokenError('License token carries an unknown mode');
  }

  return {
    iss: payload.iss as string,
    sub: payload.sub,
    jti: payload.jti as string,
    tier: payload.tier,
    features: payload.features,
    customer: payload.customer,
    instanceLimit: typeof payload.instanceLimit === 'number' ? payload.instanceLimit : 1,
    mode: payload.mode,
    licenseExpiresAt: payload.licenseExpiresAt as string | null | undefined,
    iat: payload.iat as number,
    exp: payload.exp,
  };
}

export function claimsToEntitlement(claims: LicenseTokenClaims): EntitlementResponse {
  return {
    valid: true,
    tier: claims.tier,
    features: claims.features ?? TIER_FEATURES[claims.tier],
    // Prefer the license's real expiry so a perpetual (null) or far-future
    // license isn't misreported as expiring at the token's short `exp`. Older
    // tokens omit the claim (undefined) — fall back to `exp` for them.
    expiresAt:
      claims.licenseExpiresAt !== undefined
        ? claims.licenseExpiresAt
        : new Date(claims.exp * 1000).toISOString(),
    customer: claims.customer
      ? {
          // Real customer id from the signed claim; older tokens without it
          // fall back to sub (the license id) rather than inventing a value.
          id: claims.customer.id ?? claims.sub,
          name: claims.customer.name,
          email: claims.customer.email,
        }
      : undefined,
    instanceLimit: claims.instanceLimit,
  };
}
