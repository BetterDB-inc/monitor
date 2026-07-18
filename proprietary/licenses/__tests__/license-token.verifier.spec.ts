import { generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Tier, TIER_FEATURES } from '../types';
import { verifyLicenseToken, claimsToEntitlement, LicenseTokenError } from '../license-token.verifier';

const ISSUER = 'betterdb-entitlement';

describe('license-token.verifier', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const keys = { 'lic-test': publicKey };

  const signToken = (
    payload: Record<string, unknown> = {},
    options: jwt.SignOptions = {},
    key: string = privateKey,
  ) =>
    jwt.sign(
      {
        tier: Tier.pro,
        instanceLimit: 3,
        mode: 'offline',
        customer: { name: 'Acme', email: 'ops@acme.test' },
        ...payload,
      },
      key,
      {
        algorithm: 'RS256',
        issuer: ISSUER,
        subject: 'license-1',
        keyid: 'lic-test',
        jwtid: 'jti-1',
        expiresIn: '1h',
        ...options,
      },
    );

  it('verifies a valid token and returns normalized claims', () => {
    const claims = verifyLicenseToken(signToken(), keys);

    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: 'license-1',
      jti: 'jti-1',
      tier: Tier.pro,
      instanceLimit: 3,
      mode: 'offline',
      customer: { name: 'Acme', email: 'ops@acme.test' },
    });
    expect(typeof claims.exp).toBe('number');
  });

  it('rejects garbage input', () => {
    expect(() => verifyLicenseToken('not-a-jwt', keys)).toThrow(LicenseTokenError);
  });

  it('rejects tokens signed with an unknown kid', () => {
    const token = signToken({}, { keyid: 'lic-9999' });
    expect(() => verifyLicenseToken(token, keys)).toThrow(/unknown key/);
  });

  it('rejects tokens signed with the wrong private key', () => {
    const token = signToken({}, {}, otherPrivateKey);
    expect(() => verifyLicenseToken(token, keys)).toThrow(/verification failed/);
  });

  it('rejects tampered tokens', () => {
    const token = signToken();
    const [header, payload, sig] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    forged.tier = Tier.enterprise;
    const tampered = [header, Buffer.from(JSON.stringify(forged)).toString('base64url'), sig].join('.');
    expect(() => verifyLicenseToken(tampered, keys)).toThrow(LicenseTokenError);
  });

  it('rejects expired tokens with a re-download hint', () => {
    const token = signToken({}, { expiresIn: '-1h' });
    expect(() => verifyLicenseToken(token, keys)).toThrow(/expired/);
  });

  it('rejects the none algorithm', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'lic-test' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: ISSUER, sub: 'l1', tier: Tier.enterprise, mode: 'offline', exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    expect(() => verifyLicenseToken(`${header}.${payload}.`, keys)).toThrow(LicenseTokenError);
  });

  it('rejects wrong issuer and unknown tier/mode', () => {
    expect(() => verifyLicenseToken(signToken({}, { issuer: 'someone-else' }), keys)).toThrow(LicenseTokenError);
    expect(() => verifyLicenseToken(signToken({ tier: 'platinum' }), keys)).toThrow(/unknown tier/);
    expect(() => verifyLicenseToken(signToken({ mode: 'sideways' }), keys)).toThrow(/unknown mode/);
  });

  it('maps claims to an EntitlementResponse', () => {
    const claims = verifyLicenseToken(signToken(), keys);
    const response = claimsToEntitlement(claims);

    expect(response).toMatchObject({
      valid: true,
      tier: Tier.pro,
      instanceLimit: 3,
      // No customer.id in this token → falls back to sub (the license id).
      customer: { id: 'license-1', name: 'Acme', email: 'ops@acme.test' },
    });
    expect(response.expiresAt).toBe(new Date(claims.exp * 1000).toISOString());
  });

  it('reports the license expiry from licenseExpiresAt, not the short token exp', () => {
    const licenseExpiresAt = '2027-03-01T00:00:00.000Z';
    const claims = verifyLicenseToken(signToken({ licenseExpiresAt }), keys);
    const response = claimsToEntitlement(claims);
    // token exp is ~1h out; the response must reflect the real license expiry
    expect(response.expiresAt).toBe(licenseExpiresAt);
    expect(response.expiresAt).not.toBe(new Date(claims.exp * 1000).toISOString());
  });

  it('preserves a perpetual (null) license expiry rather than inventing the token exp', () => {
    const claims = verifyLicenseToken(signToken({ licenseExpiresAt: null }), keys);
    const response = claimsToEntitlement(claims);
    expect(response.expiresAt).toBeNull();
  });

  it('uses the real customer id from the claim when present (not the license id)', () => {
    const claims = verifyLicenseToken(
      signToken({ customer: { id: 'cust-42', name: 'Acme', email: 'ops@acme.test' } }),
      keys,
    );
    const response = claimsToEntitlement(claims);
    expect(response.customer?.id).toBe('cust-42');
  });

  it('derives features from tier when the claim is absent', () => {
    const claims = verifyLicenseToken(signToken({ features: undefined }), keys);
    const response = claimsToEntitlement(claims);
    expect(response.features).toEqual(TIER_FEATURES[Tier.pro]);
  });
});
