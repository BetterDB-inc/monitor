import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Tier, TIER_FEATURES, LICENSE_JWT_ISSUER } from '@betterdb/shared';
import { LicenseSigningService } from '../license-signing.service';

describe('LicenseSigningService', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const originalEnv = {
    key: process.env.LICENSE_SIGNING_PRIVATE_KEY,
    kid: process.env.LICENSE_SIGNING_KID,
  };

  afterEach(() => {
    process.env.LICENSE_SIGNING_PRIVATE_KEY = originalEnv.key;
    process.env.LICENSE_SIGNING_KID = originalEnv.kid;
    if (originalEnv.key === undefined) delete process.env.LICENSE_SIGNING_PRIVATE_KEY;
    if (originalEnv.kid === undefined) delete process.env.LICENSE_SIGNING_KID;
  });

  function configuredService(): LicenseSigningService {
    process.env.LICENSE_SIGNING_PRIVATE_KEY = privateKey;
    process.env.LICENSE_SIGNING_KID = 'lic-test';
    return new LicenseSigningService();
  }

  it('fails fast in production when the signing key is missing', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.LICENSE_SIGNING_PRIVATE_KEY;
    delete process.env.LICENSE_SIGNING_KID;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new LicenseSigningService()).toThrow(/must be configured in production/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('fails fast in production when the key is present but malformed', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.LICENSE_SIGNING_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----';
    process.env.LICENSE_SIGNING_KID = 'lic-test';
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new LicenseSigningService()).toThrow(/signing key check failed/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('fails fast in production when the key does not match the fleet-trusted kid', () => {
    // A syntactically valid key, but NOT the real lic-2026-01 key monitors embed.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.LICENSE_SIGNING_PRIVATE_KEY = privateKey;
    process.env.LICENSE_SIGNING_KID = 'lic-2026-01';
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new LicenseSigningService()).toThrow(/does not match the public key the fleet trusts/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('marks a malformed key unconfigured outside production', () => {
    process.env.LICENSE_SIGNING_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----';
    process.env.LICENSE_SIGNING_KID = 'lic-test';
    const service = new LicenseSigningService();
    expect(service.isConfigured).toBe(false);
  });

  it('reports unconfigured when env vars are missing', () => {
    delete process.env.LICENSE_SIGNING_PRIVATE_KEY;
    delete process.env.LICENSE_SIGNING_KID;
    const service = new LicenseSigningService();
    expect(service.isConfigured).toBe(false);
    expect(() =>
      service.signLicenseToken(
        { licenseId: 'l1', tier: Tier.pro, instanceLimit: 1, mode: 'online' },
        new Date(),
      ),
    ).toThrow('not configured');
  });

  it('signs a verifiable RS256 token with the expected claims', () => {
    const service = configuredService();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const signed = service.signLicenseToken(
      {
        licenseId: 'license-1',
        tier: Tier.enterprise,
        customer: { id: 'cust-1', name: 'Acme', email: 'ops@acme.test' },
        instanceLimit: 10,
        mode: 'offline',
      },
      expiresAt,
    );

    expect(signed.kid).toBe('lic-test');
    expect(signed.jti).toBeTruthy();

    const decoded = jwt.verify(signed.token, publicKey, {
      algorithms: ['RS256'],
      issuer: LICENSE_JWT_ISSUER,
    }) as jwt.JwtPayload;

    expect(decoded.sub).toBe('license-1');
    expect(decoded.jti).toBe(signed.jti);
    expect(decoded.tier).toBe(Tier.enterprise);
    expect(decoded.features).toEqual(TIER_FEATURES[Tier.enterprise]);
    expect(decoded.customer).toEqual({ id: 'cust-1', name: 'Acme', email: 'ops@acme.test' });
    expect(decoded.instanceLimit).toBe(10);
    expect(decoded.mode).toBe('offline');
    expect(decoded.exp).toBe(Math.floor(expiresAt.getTime() / 1000));

    const header = jwt.decode(signed.token, { complete: true })!.header;
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe('lic-test');
  });

  it('accepts \\n-escaped PEM private keys', () => {
    process.env.LICENSE_SIGNING_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');
    process.env.LICENSE_SIGNING_KID = 'lic-test';
    const service = new LicenseSigningService();

    const signed = service.signLicenseToken(
      { licenseId: 'l1', tier: Tier.pro, instanceLimit: 1, mode: 'online' },
      new Date(Date.now() + 1000 * 60),
    );

    expect(() => jwt.verify(signed.token, publicKey, { algorithms: ['RS256'] })).not.toThrow();
  });
});
