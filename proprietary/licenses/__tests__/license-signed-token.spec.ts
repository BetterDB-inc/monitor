import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, createHash } from 'crypto';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import { LicenseService } from '../license.service';
import { Tier } from '../types';

// Swap the embedded production keys for a test keypair (lazy getter so the
// keys exist by the time the verifier reads them).
const mockKeyState: { keys: Record<string, string> } = { keys: {} };
jest.mock('../license-signing-keys', () => ({
  get LICENSE_SIGNING_PUBLIC_KEYS() {
    return mockKeyState.keys;
  },
}));

// Virtual filesystem: node's fs properties are non-configurable, so replace
// the module instead of spying on it.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn(actual.readFileSync),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    unlinkSync: jest.fn(),
  };
});

describe('LicenseService signed tokens & offline licenses', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  mockKeyState.keys = { 'lic-test': publicKey };

  const originalEnv = process.env;
  let mockFetch: jest.SpyInstance;
  // Virtual file contents keyed by basename (license.key, license.jwt, ...)
  let files: Record<string, string>;

  const signToken = (payload: Record<string, unknown> = {}, options: jwt.SignOptions = {}) =>
    jwt.sign(
      {
        tier: Tier.pro,
        instanceLimit: 3,
        mode: 'online',
        customer: { name: 'Acme', email: 'ops@acme.test' },
        ...payload,
      },
      privateKey,
      {
        algorithm: 'RS256',
        issuer: 'betterdb-entitlement',
        subject: 'license-1',
        keyid: 'lic-test',
        jwtid: 'jti-1',
        expiresIn: '7d',
        ...options,
      },
    );

  const createMockResponse = (data: Record<string, unknown>, ok = true, status = ok ? 200 : 500) => ({
    ok,
    status,
    json: jest.fn().mockResolvedValue(data),
  });

  // Persisted entitlement tokens are stored bound to the key that earned them
  const persistedJwtFile = (token: string, key: string) =>
    JSON.stringify({
      keyFingerprint: createHash('sha256').update(key).digest('hex').slice(0, 16),
      token,
    });

  const createService = async (): Promise<LicenseService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LicenseService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: 'TELEMETRY_CLIENT', useValue: { capture: jest.fn() } },
      ],
    }).compile();
    return module.get<LicenseService>(LicenseService);
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BETTERDB_LICENSE_KEY;
    delete process.env.BETTERDB_OFFLINE_LICENSE;
    delete process.env.BETTERDB_OFFLINE_LICENSE_FILE;

    files = {};
    (fs.readFileSync as jest.Mock).mockImplementation((path: unknown) => {
      const match = Object.keys(files).find((suffix) => String(path).endsWith(suffix));
      if (match === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return files[match];
    });
    (fs.writeFileSync as jest.Mock).mockImplementation((path: unknown, data: unknown) => {
      files[String(path).split('/').pop() as string] = String(data);
    });
    (fs.unlinkSync as jest.Mock).mockImplementation((path: unknown) => {
      const name = String(path).split('/').pop() as string;
      if (!(name in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      delete files[name];
    });
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    process.env = originalEnv;
    mockFetch.mockRestore();
    (fs.readFileSync as jest.Mock).mockReset();
    (fs.writeFileSync as jest.Mock).mockReset();
    (fs.unlinkSync as jest.Mock).mockReset();
  });

  describe('online signed entitlement tokens', () => {
    it('verifies and persists the token from a successful online check', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      const token = signToken();
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'pro', expiresAt: null, token }),
      );

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.pro);
      expect(JSON.parse(files['license.jwt']).token).toBe(token);
      expect(service.getLicenseSource()).toBe('online');
      expect(service.getVerifiedClaims()?.sub).toBe('license-1');
    });

    it('treats a response with a tampered token as a failed validation', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      const token = signToken({ tier: Tier.pro });
      const [h, p, s] = token.split('.');
      const forged = JSON.parse(Buffer.from(p, 'base64url').toString());
      forged.tier = Tier.enterprise;
      const tampered = [h, Buffer.from(JSON.stringify(forged)).toString('base64url'), s].join('.');

      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'enterprise', expiresAt: null, token: tampered }),
      );

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.community);
      expect(files['license.jwt']).toBeUndefined();
    });

    it('derives the entitlement from verified claims, not the response body', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      // Forged body claims enterprise, but the (valid) token says pro
      const token = signToken({ tier: Tier.pro });
      mockFetch.mockResolvedValue(
        createMockResponse({
          valid: true,
          tier: 'enterprise',
          features: Object.values(Tier),
          expiresAt: '2030-01-01T00:00:00.000Z',
          instanceLimit: 999,
          token,
        }),
      );

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.pro);
      expect(result.instanceLimit).toBe(3);
      expect(service.getLicenseTier()).toBe(Tier.pro);
      // Display metadata may still come from the body
      expect(result.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    });

    it('keeps a perpetual license expiry as null instead of the token exp', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'enterprise', expiresAt: null, token: signToken({ tier: Tier.enterprise }) }),
      );

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.enterprise);
      expect(result.expiresAt).toBeNull();
    });

    it('refuses unsigned paid grants by default (spoofable ENTITLEMENT_URL)', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'enterprise', expiresAt: null }),
      );

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.valid).toBe(false);
      expect(result.tier).toBe(Tier.community);
      expect(service.getLicenseTier()).toBe(Tier.community);
    });

    it('keeps the persisted-jwt grace when refusing an unsigned grant (outage, not rejection)', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      files['license.jwt'] = persistedJwtFile(signToken(), 'valid-license-key-12345');
      // Server reachable but signing broken → unsigned paid grant
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'pro', expiresAt: null }),
      );

      const service = await createService();
      const result = await service.validateLicense();

      // Grace window survives: entitlement served from the persisted token,
      // and the file is NOT cleared
      expect(result.tier).toBe(Tier.pro);
      expect(service.getLicenseSource()).toBe('persisted-jwt');
      expect(files['license.jwt']).toBeDefined();
    });

    it('still honors an offline token when the server sends unsigned paid grants', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline', tier: Tier.enterprise });
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'pro', expiresAt: null }),
      );

      const service = await createService();
      await service.onModuleInit();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.enterprise);
      expect(service.getLicenseSource()).toBe('offline-token');
      service.onModuleDestroy();
    });

    it('accepts token-less paid responses only with LICENSE_ALLOW_UNSIGNED=true', async () => {
      process.env.LICENSE_ALLOW_UNSIGNED = 'true';
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'pro', expiresAt: null }),
      );

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.pro);
      expect(files['license.jwt']).toBeUndefined();
    });

    it('rejects an offline-mode token replayed on the online path', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      const offlineToken = signToken({ mode: 'offline', tier: Tier.enterprise });
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'enterprise', expiresAt: null, token: offlineToken }),
      );

      const service = await createService();
      const result = await service.validateLicense();

      // Not accepted as an online grant; not persisted
      expect(result.tier).toBe(Tier.community);
      expect(files['license.jwt']).toBeUndefined();
    });

    it('rejects a server-supplied release URL outside the org path', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      mockFetch.mockResolvedValue(
        createMockResponse({
          valid: true,
          tier: 'community',
          expiresAt: null,
          latestVersion: '9.9.9',
          releaseUrl: 'https://github.com/evil/repo/releases',
        }),
      );

      const service = await createService();
      await service.validateLicense();

      expect(service.getVersionInfo().releaseUrl).toBe(
        'https://github.com/betterdb-inc/monitor/releases/tag/v9.9.9',
      );
    });
  });

  describe('fallback chain when the entitlement server is unreachable', () => {
    it('falls back to the persisted signed entitlement', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      files['license.jwt'] = persistedJwtFile(signToken(), 'valid-license-key-12345');
      mockFetch.mockRejectedValue(new Error('network down'));

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.pro);
      expect(service.getLicenseSource()).toBe('persisted-jwt');
      // Feature gating must see the fallback tier
      expect(service.getLicenseTier()).toBe(Tier.pro);
    });

    it('rejects a tampered persisted entitlement and falls through to community', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      const token = signToken();
      files['license.jwt'] = persistedJwtFile(token.slice(0, -6) + 'AAAAAA', 'valid-license-key-12345');
      mockFetch.mockRejectedValue(new Error('network down'));

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.community);
    });

    it('ignores a persisted entitlement earned by a different license key', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'brand-new-key-567890';
      // Token was persisted while a different key was active
      files['license.jwt'] = persistedJwtFile(signToken({ tier: Tier.enterprise }), 'old-key-123456');
      mockFetch.mockRejectedValue(new Error('network down'));

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.community);
      expect(service.getLicenseSource()).not.toBe('persisted-jwt');
    });

    it('does not honor a persisted token on a pure-keyless instance (copied-file attack)', async () => {
      // No license key, not cloud. An attacker drops a valid cloud/forged
      // enterprise token (empty-key fingerprint) into license.jwt.
      files['license.jwt'] = persistedJwtFile(signToken({ tier: Tier.enterprise }), '');
      mockFetch.mockRejectedValue(new Error('network down'));

      const service = await createService();
      const result = await service.validateLicense();

      // Keyless instances have no credential to bind to → the dropped token is
      // never honored; stays community.
      expect(result.tier).toBe(Tier.community);
      expect(service.getLicenseSource()).not.toBe('persisted-jwt');
    });

    it('binds the persisted token to the cloud tenant (rejects another tenant\'s token)', async () => {
      process.env.CLOUD_MODE = 'true';
      process.env.DB_SCHEMA = 'tenant_acme';
      // A token persisted under a DIFFERENT tenant's credential
      const foreign = JSON.stringify({
        keyFingerprint: createHash('sha256').update('cloud:tenant_other').digest('hex').slice(0, 16),
        token: signToken({ tier: Tier.enterprise }),
      });
      files['license.jwt'] = foreign;
      mockFetch.mockRejectedValue(new Error('network down'));

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.community);
      expect(service.getLicenseSource()).not.toBe('persisted-jwt');
      delete process.env.CLOUD_MODE;
      delete process.env.DB_SCHEMA;
    });

    it('falls back to an offline license token after persisted jwt is unavailable', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline', tier: Tier.enterprise });
      mockFetch.mockRejectedValue(new Error('network down'));

      const service = await createService();
      await service.onModuleInit();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.enterprise);
      expect(service.getLicenseSource()).toBe('offline-token');
      service.onModuleDestroy();
    });
  });

  describe('rejection (200 valid:false) vs infra failure (non-2xx)', () => {
    it('keeps the persisted-jwt grace on HTTP 401 (infra, not a license rejection)', async () => {
      // Post-C2, a bad key returns 200 valid:false — so a 401 reaching the
      // monitor is a gateway/proxy failure and must NOT wipe the grace token.
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      files['license.jwt'] = persistedJwtFile(signToken(), 'valid-license-key-12345');
      mockFetch.mockResolvedValue(createMockResponse({ error: 'gateway' }, false, 401));

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.pro);
      expect(service.getLicenseSource()).toBe('persisted-jwt');
      expect(files['license.jwt']).toBeDefined();
    });

    it('clears the persisted token on a valid:false response', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'expired-license-key-1234';
      files['license.jwt'] = persistedJwtFile(signToken(), 'expired-license-key-1234');
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: false, tier: 'community', expiresAt: null, error: 'License has expired' }),
      );

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.valid).toBe(false);
      expect(files['license.jwt']).toBeUndefined();
      expect(service.getVerifiedClaims()).toBeNull();
    });

    it('falls back to an offline license token on a valid:false response', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'deactivated-key-123456';
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline', tier: Tier.enterprise });
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: false, tier: 'community', expiresAt: null, error: 'License has been deactivated' }),
      );

      const service = await createService();
      await service.onModuleInit();
      const result = await service.validateLicense();

      // Issued offline tokens are irrevocable until exp — deactivation of the
      // key must not drop paid features while a valid token is loaded
      expect(result.tier).toBe(Tier.enterprise);
      expect(service.getLicenseSource()).toBe('offline-token');
      service.onModuleDestroy();
    });

    it('honors an offline license token on an infra failure (401)', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'revoked-license-key-1234';
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline', tier: Tier.enterprise });
      mockFetch.mockResolvedValue(createMockResponse({ error: 'gateway' }, false, 401));

      const service = await createService();
      await service.onModuleInit();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.enterprise);
      expect(service.getLicenseSource()).toBe('offline-token');
      // Fallback via offline token is NOT air-gapped — a key is configured
      expect(service.isAirGapped()).toBe(false);
      service.onModuleDestroy();
    });

    it('keeps the jwt fallback for 5xx errors (server unreachable/broken)', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      files['license.jwt'] = persistedJwtFile(signToken(), 'valid-license-key-12345');
      mockFetch.mockResolvedValue(createMockResponse({}, false, 503));

      const service = await createService();
      const result = await service.validateLicense();

      expect(result.tier).toBe(Tier.pro);
      expect(service.getLicenseSource()).toBe('persisted-jwt');
      expect(files['license.jwt']).toBeDefined();
    });

    it('downgrades to community (and clears the paid cache) once the persisted token expires', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      // Persisted signed token that is already past its exp
      files['license.jwt'] = persistedJwtFile(
        signToken({}, { expiresIn: '-1h' }),
        'valid-license-key-12345',
      );
      mockFetch.mockRejectedValue(new Error('network down'));

      const service = await createService();
      const result = await service.validateLicense();

      // No paid grace past the token's exp — and the read-path getters must
      // reflect community, not a lingering stale paid cache.
      expect(result.tier).toBe(Tier.community);
      expect(service.getLicenseTier()).toBe(Tier.community);
      expect(service.hasFeature('keyAnalytics')).toBe(false);
      expect(service.getVerifiedClaims()).toBeNull();
    });
  });

  describe('mode transitions', () => {
    it('does not override the active online entitlement when a key is configured', async () => {
      process.env.BETTERDB_TELEMETRY = 'true'; // jest setup-env forces 'false'
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'pro', expiresAt: null, token: signToken() }),
      );

      const service = await createService();
      await service.validateLicense();
      expect(service.getLicenseSource()).toBe('online');

      const result = await service.activateOfflineLicense(
        signToken({ mode: 'offline', tier: Tier.enterprise }),
      );

      // Online entitlement stays active; the token is fallback only — and the
      // activation response must say so instead of reporting the offline tier
      expect(result.fallbackOnly).toBe(true);
      expect(result.entitlement.tier).toBe(Tier.pro);
      expect(service.getLicenseTier()).toBe(Tier.pro);
      expect(service.getLicenseSource()).toBe('online');
      expect(service.isAirGapped()).toBe(false);
      expect(service.isTelemetryEnabled).toBe(true);
      expect(files['license-offline.jwt']).toBeDefined();
      service.onModuleDestroy();
    });

    it('re-validates online on activation so a paid online grant is not clobbered by a stale cache', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
      // Cache is empty (no prior validateLicense) — simulates an online check
      // that would grant paid but hasn't populated the cache yet.
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'pro', expiresAt: null, token: signToken() }),
      );

      const service = await createService();
      const result = await service.activateOfflineLicense(
        signToken({ mode: 'offline', tier: Tier.enterprise }),
      );

      // Online precedence wins via the re-validation — pro, fallback-only —
      // rather than the offline enterprise being applied off a stale cache.
      expect(result.entitlement.tier).toBe(Tier.pro);
      expect(result.fallbackOnly).toBe(true);
      expect(service.getLicenseSource()).toBe('online');
      expect(files['license-offline.jwt']).toBeDefined();
    });

    it('applies the offline token immediately when the configured key is not granting a tier', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'revoked-license-key-1234';
      mockFetch.mockResolvedValue(createMockResponse({ error: 'Invalid license key' }, false, 401));

      const service = await createService();
      const rejected = await service.validateLicense();
      expect(rejected.tier).toBe(Tier.community);

      const result = await service.activateOfflineLicense(
        signToken({ mode: 'offline', tier: Tier.enterprise }),
      );

      // No waiting out the cache TTL — the offline tier is active right away
      expect(result.fallbackOnly).toBe(false);
      expect(result.entitlement.tier).toBe(Tier.enterprise);
      expect(service.getLicenseTier()).toBe(Tier.enterprise);
      expect(service.getLicenseSource()).toBe('offline-token');
      // Still not air-gapped: the key stays configured and may recover online
      expect(service.isAirGapped()).toBe(false);
    });

    it('does not let a later online-community heartbeat revert an applied offline token', async () => {
      process.env.BETTERDB_LICENSE_KEY = 'lapsed-license-key-1234';
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline', tier: Tier.enterprise });
      // Server reachable and says this key is community (e.g. lapsed sub)
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'community', expiresAt: null }),
      );

      const service = await createService();
      await service.onModuleInit();

      // The heartbeat's validateLicense sees valid community — must still honor
      // the loaded offline token, not overwrite the tier with community
      const result = await service.validateLicense();
      expect(result.tier).toBe(Tier.enterprise);
      expect(service.getLicenseSource()).toBe('offline-token');
      service.onModuleDestroy();
    });

    it('retries online immediately after an offline fallback expires (no cache pinning)', async () => {
      jest.useFakeTimers({ now: Date.now() });
      try {
        process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
        process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline', tier: Tier.enterprise }, { expiresIn: '1h' });
        // Long-lived online token so it's still valid after the time jump
        const onlineToken = signToken({ tier: Tier.pro }, { expiresIn: '30d' });
        mockFetch.mockRejectedValue(new Error('network down'));

        const service = await createService();
        await service.onModuleInit();
        await service.validationPromise;

        // Server down → offline token acts as fallback
        expect(service.getLicenseSource()).toBe('offline-token');

        // Token expires → community, but the key is still valid server-side
        jest.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
        expect(service.getLicenseTier()).toBe(Tier.community);

        // Server recovers: the very next validation must go online — not sit
        // on the freshly-stamped community cache for the full TTL
        mockFetch.mockResolvedValue(
          createMockResponse({ valid: true, tier: 'pro', expiresAt: null, token: onlineToken }),
        );
        const recovered = await service.validateLicense();
        expect(recovered.tier).toBe(Tier.pro);
        expect(service.getLicenseSource()).toBe('online');
        service.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('discards an in-flight keyless validation that resolves after offline activation', async () => {
      let resolveFetch!: (value: unknown) => void;
      mockFetch.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

      const service = await createService();
      const inflight = service.validateLicense(); // keyless online check, hangs
      await new Promise(process.nextTick);

      await service.activateOfflineLicense(signToken({ mode: 'offline', tier: Tier.enterprise }));
      expect(service.getLicenseTier()).toBe(Tier.enterprise);
      expect(service.isAirGapped()).toBe(true);

      resolveFetch(createMockResponse({ valid: true, tier: 'community', expiresAt: null }));
      const inflightResult = await inflight;

      // The stale community response must not overwrite air-gapped state,
      // and the in-flight caller must see the ACTIVE entitlement, not the
      // discarded one
      expect(inflightResult.tier).toBe(Tier.enterprise);
      expect(service.getLicenseTier()).toBe(Tier.enterprise);
      expect(service.getLicenseSource()).toBe('offline-token');
      service.onModuleDestroy();
    });

    it('exits air-gapped mode when an online key is activated at runtime', async () => {
      process.env.BETTERDB_TELEMETRY = 'true'; // jest setup-env forces 'false'
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline' });

      const service = await createService();
      await service.onModuleInit();
      expect(service.isTelemetryEnabled).toBe(false);

      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'enterprise', expiresAt: null, token: signToken({ tier: Tier.enterprise }) }),
      );
      const info = await service.activateLicenseKey('new-online-key-123456');

      expect(info.valid).toBe(true);
      expect(service.isTelemetryEnabled).toBe(true);
      expect(service.getLicenseSource()).toBe('online');
      expect(service.getLicenseTier()).toBe(Tier.enterprise);
      expect(files['license.jwt']).toBeDefined();
      service.onModuleDestroy();
    });
  });

  describe('air-gapped mode', () => {
    it('force-disables telemetry in the constructor, before onModuleInit (boot race)', async () => {
      process.env.BETTERDB_TELEMETRY = 'true'; // jest setup-env forces false
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline' });

      // createService() only constructs — no onModuleInit yet. Telemetry must
      // already be off so UsageTelemetryService (which may init first) sees it.
      const service = await createService();

      expect(service.isTelemetryEnabled).toBe(false);
      expect(service.isAirGapped()).toBe(true);
    });

    it('keeps re-validating the license when telemetry is disabled (not air-gapped)', async () => {
      jest.useFakeTimers({ now: Date.now() });
      try {
        process.env.BETTERDB_TELEMETRY = 'false';
        process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';
        mockFetch.mockResolvedValue(
          createMockResponse({ valid: true, tier: 'pro', expiresAt: null, token: signToken() }),
        );

        const service = await createService();
        await service.onModuleInit();
        await service.validationPromise;
        const afterBoot = mockFetch.mock.calls.length;

        // Advance past the re-validation interval (default 1h). Telemetry is
        // off but license enforcement must still re-check.
        await jest.advanceTimersByTimeAsync(3_600_000 + 1000);

        expect(mockFetch.mock.calls.length).toBeGreaterThan(afterBoot);
        service.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('runs entirely offline when an offline license is set and no key is configured', async () => {
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline' }, { expiresIn: '300d' });

      const service = await createService();
      await service.onModuleInit();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(service.getLicenseTier()).toBe(Tier.pro);
      expect(service.getLicenseSource()).toBe('offline-token');
      expect(service.isTelemetryEnabled).toBe(false);
      expect(service.isValidationComplete()).toBe(true);
      expect(service.getOfflineExpiresAt()).toBeTruthy();
      service.onModuleDestroy();
    });

    it('loads the offline license from a file path', async () => {
      process.env.BETTERDB_OFFLINE_LICENSE_FILE = '/mounted/secret/license-offline.jwt';
      files['license-offline.jwt'] = signToken({ mode: 'offline' });

      const service = await createService();
      await service.onModuleInit();

      expect(service.getLicenseTier()).toBe(Tier.pro);
      service.onModuleDestroy();
    });

    it('falls back to the default file when the configured path is unreadable', async () => {
      process.env.BETTERDB_OFFLINE_LICENSE_FILE = '/nonexistent/path/license.jwt';
      // Only the default data/license-offline.jwt exists (e.g. UI-activated earlier)
      files['license-offline.jwt'] = signToken({ mode: 'offline', tier: Tier.enterprise });
      // Make the virtual fs distinguish the two paths
      (fs.readFileSync as jest.Mock).mockImplementation((path: unknown) => {
        if (String(path).startsWith('/nonexistent/')) {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        }
        const match = Object.keys(files).find((suffix) => String(path).endsWith(suffix));
        if (match === undefined) {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        }
        return files[match];
      });

      const service = await createService();
      await service.onModuleInit();

      expect(service.getLicenseTier()).toBe(Tier.enterprise);
      expect(service.getLicenseSource()).toBe('offline-token');
      service.onModuleDestroy();
    });

    it('never phones home in air-gapped mode — refresh and startup errors included', async () => {
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline' });

      const service = await createService();
      await service.onModuleInit();

      const refreshed = await service.refreshLicense();
      await service.sendStartupError('boom', 'test');

      expect(refreshed.tier).toBe(Tier.pro);
      expect(service.getLicenseSource()).toBe('offline-token');
      expect(mockFetch).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('downgrades immediately on read once the offline token expires', async () => {
      jest.useFakeTimers({ now: Date.now() });
      try {
        process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline' }, { expiresIn: '1h' });
        const service = await createService();
        await service.onModuleInit();
        expect(service.getLicenseTier()).toBe(Tier.pro);

        // No daily timer tick needed — the read path itself must enforce exp
        jest.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
        expect(service.getLicenseTier()).toBe(Tier.community);
        expect(service.hasFeature('keyAnalytics')).toBe(false);
        expect(service.getVerifiedClaims()).toBeNull();
        service.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('ignores an expired offline license and stays community', async () => {
      process.env.BETTERDB_OFFLINE_LICENSE = signToken({ mode: 'offline' }, { expiresIn: '-1d' });
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'community', expiresAt: null }),
      );

      const service = await createService();
      await service.onModuleInit();

      expect(service.getLicenseTier()).toBe(Tier.community);
      service.onModuleDestroy();
    });
  });

  describe('activateOfflineLicense', () => {
    it('activates and persists a valid offline token', async () => {
      const token = signToken({ mode: 'offline', tier: Tier.enterprise });
      const service = await createService();

      const result = await service.activateOfflineLicense(token);

      expect(result.entitlement.valid).toBe(true);
      expect(result.entitlement.tier).toBe(Tier.enterprise);
      expect(result.fallbackOnly).toBe(false);
      expect(files['license-offline.jwt']).toBe(token);
      expect(service.getLicenseSource()).toBe('offline-token');
      expect(service.getLicenseTier()).toBe(Tier.enterprise);
      service.onModuleDestroy();
    });

    it('enters air-gapped mode on UI activation when no key is configured', async () => {
      const token = signToken({ mode: 'offline', tier: Tier.enterprise });
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'community', expiresAt: null }),
      );
      const service = await createService();
      await service.onModuleInit(); // boots keyless, heartbeat may be armed
      await service.validationPromise;

      await service.activateOfflineLicense(token);

      expect(service.isTelemetryEnabled).toBe(false);
      expect(service.getLicenseSource()).toBe('offline-token');

      // A later validation must NOT phone home and downgrade to community
      mockFetch.mockClear();
      const revalidated = await service.validateLicense();
      expect(revalidated.tier).toBe(Tier.enterprise);
      expect(mockFetch).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('rejects an online-mode token', async () => {
      const service = await createService();
      const result = await service.activateOfflineLicense(signToken({ mode: 'online' }));

      expect(result.entitlement.valid).toBe(false);
      expect(result.entitlement.error).toContain('Not an offline license token');
      expect(service.getLicenseTier()).toBe(Tier.community);
    });

    it('rejects garbage without committing state', async () => {
      const service = await createService();
      const result = await service.activateOfflineLicense('garbage-token');

      expect(result.entitlement.valid).toBe(false);
      expect(files['license-offline.jwt']).toBeUndefined();
      expect(service.getLicenseTier()).toBe(Tier.community);
    });
  });

  describe('clock rollback detection', () => {
    it('flags a suspected rollback when the clock file is far in the future', async () => {
      files['license-clock.json'] = JSON.stringify({
        lastSeenAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
      });

      const service = await createService();
      await service.onModuleInit();

      expect(service.isClockRollbackSuspected()).toBe(true);
      service.onModuleDestroy();
    });

    it('does not flag normal clock progression', async () => {
      files['license-clock.json'] = JSON.stringify({ lastSeenAt: Date.now() - 1000 });
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'community', expiresAt: null }),
      );

      const service = await createService();
      await service.onModuleInit();

      expect(service.isClockRollbackSuspected()).toBe(false);
      service.onModuleDestroy();
    });
  });
});
