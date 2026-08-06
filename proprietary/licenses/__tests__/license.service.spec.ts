import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LicenseService } from '../license.service';
import { TelemetryPort } from '@app/common/interfaces/telemetry-port.interface';

const createMockTelemetryClient = (): jest.Mocked<TelemetryPort> => ({
  capture: jest.fn(),
  identify: jest.fn(),
  shutdown: jest.fn().mockResolvedValue(undefined),
});

describe('LicenseService', () => {
  let service: LicenseService;
  let mockFetch: jest.SpyInstance;
  let mockTelemetryClient: jest.Mocked<TelemetryPort>;

  const originalEnv = process.env;

  const flushPromises = () => new Promise(process.nextTick);

  const createMockResponse = (data: Record<string, unknown>, ok = true) => ({
    ok,
    json: jest.fn().mockResolvedValue(data),
  });

  const createDeferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  beforeEach(async () => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // These specs predate signed entitlement tokens and mock unsigned responses
    process.env.LICENSE_ALLOW_UNSIGNED = 'true';
    mockTelemetryClient = createMockTelemetryClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LicenseService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: 'TELEMETRY_CLIENT',
          useValue: mockTelemetryClient,
        },
      ],
    }).compile();

    service = module.get<LicenseService>(LicenseService);
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    process.env = originalEnv;
    mockFetch.mockRestore();
  });

  describe('keyless validation', () => {
    beforeEach(() => {
      delete process.env.BETTERDB_LICENSE_KEY;
      process.env.BETTERDB_TELEMETRY = 'false';
    });

    it('should call entitlement server on startup even without license key', async () => {
      mockFetch.mockResolvedValue(createMockResponse({
        valid: true,
        tier: 'community',
        expiresAt: null,
      }));

      await service.onModuleInit();
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('"licenseKey":""'),
        }),
      );
    });

    it('should call entitlement server even when telemetry is disabled', async () => {
      process.env.BETTERDB_TELEMETRY = 'false';

      mockFetch.mockResolvedValue(createMockResponse({
        valid: true,
        tier: 'community',
        expiresAt: null,
      }));

      await service.onModuleInit();
      await flushPromises();

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should gracefully degrade to community tier when server is unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await service.onModuleInit();
      await flushPromises();

      const tier = service.getLicenseTier();
      expect(tier).toBe('community');
    });

    it('should not block startup when validation fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const startTime = Date.now();
      await service.onModuleInit();
      const elapsed = Date.now() - startTime;

      // onModuleInit should return quickly (non-blocking)
      expect(elapsed).toBeLessThan(1000);
    });

    it('should send instanceId and stats in keyless request', async () => {
      mockFetch.mockResolvedValue(createMockResponse({
        valid: true,
        tier: 'community',
        expiresAt: null,
      }));

      await service.onModuleInit();
      await flushPromises();

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody).toHaveProperty('instanceId');
      expect(callBody).toHaveProperty('stats');
      expect(callBody.telemetryEnabled).toBe(false); // setup forces BETTERDB_TELEMETRY=false
      expect(callBody.stats).toHaveProperty('platform');
      expect(callBody.stats).toHaveProperty('arch');
      expect(callBody.stats).toHaveProperty('nodeVersion');
    });
  });

  describe('sendStartupError', () => {
    it('should send correct payload shape with eventType startup_error', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await service.sendStartupError('connect ECONNREFUSED 127.0.0.1:6379', 'connection_refused');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body).toMatchObject({
        licenseKey: expect.any(String),
        eventType: 'startup_error',
        errorMessage: 'connect ECONNREFUSED 127.0.0.1:6379',
        errorCategory: 'connection_refused',
        instanceId: expect.any(String),
        version: expect.any(String),
        nodeVersion: expect.any(String),
        platform: expect.any(String),
        arch: expect.any(String),
        uptime: expect.any(Number),
      });
    });

    it('should truncate messages longer than 500 chars', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const longMessage = 'x'.repeat(1000);

      await service.sendStartupError(longMessage, 'unknown');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.errorMessage).toHaveLength(500);
    });

    it('should not throw when fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network unreachable'));

      await expect(
        service.sendStartupError('some error', 'unknown'),
      ).resolves.toBeUndefined();
    });

    it('should send even when BETTERDB_TELEMETRY=false', async () => {
      process.env.BETTERDB_TELEMETRY = 'false';

      // Recreate service with telemetry disabled
      const module = await Test.createTestingModule({
        providers: [
          LicenseService,
          { provide: ConfigService, useValue: { get: jest.fn() } },
        ],
      }).compile();
      const telemetryOffService = module.get<LicenseService>(LicenseService);

      mockFetch.mockResolvedValue({ ok: true });

      await telemetryOffService.sendStartupError('crash', 'unknown');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.eventType).toBe('startup_error');
    });
  });

  describe('heartbeat telemetry via adapter', () => {
    let heartbeatService: LicenseService;
    let heartbeatMock: jest.Mocked<TelemetryPort>;

    beforeEach(async () => {
      delete process.env.BETTERDB_LICENSE_KEY;
      delete process.env.BETTERDB_TELEMETRY;
      heartbeatMock = createMockTelemetryClient();

      const module = await Test.createTestingModule({
        providers: [
          LicenseService,
          { provide: ConfigService, useValue: { get: jest.fn() } },
          { provide: 'TELEMETRY_CLIENT', useValue: heartbeatMock },
        ],
      }).compile();
      heartbeatService = module.get<LicenseService>(LicenseService);
    });

    afterEach(() => {
      heartbeatService.onModuleDestroy();
    });

    it('should delegate heartbeat to telemetry adapter via capture()', () => {
      const stats = { version: 'unknown', uptime: 42 };
      (heartbeatService as any).sendHeartbeat(stats);

      expect(heartbeatMock.capture).toHaveBeenCalledTimes(1);
      expect(heartbeatMock.capture).toHaveBeenCalledWith({
        distinctId: expect.any(String),
        event: 'telemetry_ping',
        properties: expect.objectContaining({
          tier: 'community',
          deploymentMode: 'self-hosted',
          version: 'unknown',
          uptime: 42,
        }),
      });
    });

    it('should not call adapter when telemetry is disabled', async () => {
      process.env.BETTERDB_TELEMETRY = 'false';

      const module = await Test.createTestingModule({
        providers: [
          LicenseService,
          { provide: ConfigService, useValue: { get: jest.fn() } },
          { provide: 'TELEMETRY_CLIENT', useValue: heartbeatMock },
        ],
      }).compile();
      const telemetryOffService = module.get<LicenseService>(LicenseService);

      (telemetryOffService as any).sendHeartbeat({ version: 'test' });

      expect(heartbeatMock.capture).not.toHaveBeenCalled();
    });

    it('should not throw when telemetry client is not injected', async () => {
      const module = await Test.createTestingModule({
        providers: [
          LicenseService,
          { provide: ConfigService, useValue: { get: jest.fn() } },
        ],
      }).compile();
      const noClientService = module.get<LicenseService>(LicenseService);

      expect(() => (noClientService as any).sendHeartbeat({ version: 'test' })).not.toThrow();
    });
  });

  describe('version info via validateLicense', () => {
    it('should store version info from entitlement response', async () => {
      mockFetch.mockResolvedValue(createMockResponse({
        valid: true,
        tier: 'community',
        expiresAt: null,
        latestVersion: '0.5.0',
        releaseUrl: 'https://example.com/v0.5.0',
      }));

      await service.validateLicense();

      const info = service.getVersionInfo();
      expect(info.latest).toBe('0.5.0');
      // Untrusted host → derives the canonical GitHub URL rather than storing
      // the server-supplied one (phishing guard)
      expect(info.releaseUrl).toBe('https://github.com/betterdb-inc/monitor/releases/tag/v0.5.0');
    });

    it('should not throw when entitlement fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await service.validateLicense();
      expect(result.tier).toBe('community');
    });
  });

  describe('activateLicenseKey', () => {
    it('should keep previous key and entitlement when activation validation fails', async () => {
      const previousEntitlement = {
        valid: true,
        tier: 'pro',
        expiresAt: null,
      } as any;

      (service as any).licenseKey = 'valid-license-key-12345';
      (service as any).cache = {
        response: previousEntitlement,
        cachedAt: Date.now(),
      };
      (service as any).validationPromise = Promise.resolve(previousEntitlement);
      (service as any).isValidated = true;

      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await service.activateLicenseKey('new-invalid-key-987654321');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Validation failed');
      expect((service as any).licenseKey).toBe('valid-license-key-12345');
      expect(service.getLicenseInfo()).toMatchObject(previousEntitlement);
      expect(service.getLicenseTier()).toBe('pro');
    });

    it('should not expose candidate state while activation validation is pending', async () => {
      const previousEntitlement = {
        valid: true,
        tier: 'pro',
        expiresAt: null,
      } as any;

      const activationResponse = createDeferred<any>();
      (service as any).licenseKey = 'valid-license-key-12345';
      (service as any).cache = {
        response: previousEntitlement,
        cachedAt: Date.now(),
      };
      (service as any).validationPromise = Promise.resolve(previousEntitlement);
      (service as any).isValidated = true;

      mockFetch.mockImplementationOnce(() => activationResponse.promise);

      const activationPromise = service.activateLicenseKey('candidate-key-999');
      await flushPromises();

      expect((service as any).licenseKey).toBe('valid-license-key-12345');
      expect(service.getLicenseInfo()).toMatchObject(previousEntitlement);
      expect(service.getLicenseTier()).toBe('pro');
      expect((service as any).isValidated).toBe(true);

      activationResponse.resolve(createMockResponse({
        valid: false,
        tier: 'community',
        expiresAt: null,
        error: 'Invalid key',
      }));

      const result = await activationPromise;
      expect(result.valid).toBe(false);
      expect((service as any).licenseKey).toBe('valid-license-key-12345');
      expect(service.getLicenseTier()).toBe('pro');
    });

    it('should discard stale in-flight validation result after key changes', async () => {
      const staleValidationResponse = createDeferred<any>();
      (service as any).licenseKey = 'old-key-123';
      (service as any).cache = null;

      mockFetch.mockImplementationOnce(() => staleValidationResponse.promise);
      const staleValidationPromise = service.validateLicense();
      await flushPromises();

      mockFetch.mockResolvedValueOnce(createMockResponse({
        valid: true,
        tier: 'enterprise',
        expiresAt: null,
      }));

      const activationResult = await service.activateLicenseKey('new-key-456');
      expect(activationResult.valid).toBe(true);
      expect((service as any).licenseKey).toBe('new-key-456');
      expect(service.getLicenseTier()).toBe('enterprise');

      staleValidationResponse.resolve(createMockResponse({
        valid: true,
        tier: 'pro',
        expiresAt: null,
      }));
      await staleValidationPromise;

      expect((service as any).licenseKey).toBe('new-key-456');
      expect(service.getLicenseTier()).toBe('enterprise');
      expect(service.getLicenseInfo()).toMatchObject({ tier: 'enterprise' });
    });
  });

  describe('keyed validation', () => {
    let keyedService: LicenseService;

    beforeEach(async () => {
      // Set env before creating module so the service picks it up
      process.env.BETTERDB_LICENSE_KEY = 'valid-license-key-12345';

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LicenseService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(),
            },
          },
        ],
      }).compile();

      keyedService = module.get<LicenseService>(LicenseService);
    });

    it('should call entitlement server with license key', async () => {
      mockFetch.mockResolvedValue(createMockResponse({
        valid: true,
        tier: 'professional',
        expiresAt: null,
      }));

      await keyedService.onModuleInit();
      await flushPromises();

      expect(mockFetch).toHaveBeenCalled();
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.licenseKey).toBe('valid-license-key-12345');
    });

    it('should upgrade tier when license is valid', async () => {
      mockFetch.mockResolvedValue(createMockResponse({
        valid: true,
        tier: 'enterprise',
        expiresAt: null,
      }));

      await keyedService.onModuleInit();
      await flushPromises();

      const tier = keyedService.getLicenseTier();
      expect(tier).toBe('enterprise');
    });
  });

  describe('instanceId persistence', () => {
    let dataDir: string;

    const makeService = () =>
      new LicenseService({ get: jest.fn() } as unknown as ConfigService, mockTelemetryClient);

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'betterdb-license-'));
      process.env.BETTERDB_DATA_DIR = dataDir;
      process.env.BETTERDB_TELEMETRY = 'false';
      delete process.env.BETTERDB_LICENSE_KEY;
    });

    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('persists the derived id and reuses it across restarts', () => {
      const first = makeService();
      const id1 = first.getInstanceId();

      expect(existsSync(join(dataDir, 'instance-id'))).toBe(true);
      expect(readFileSync(join(dataDir, 'instance-id'), 'utf-8')).toBe(id1);

      // A fresh process with a totally different HOSTNAME (e.g. a redeployed
      // container) must still adopt the persisted id rather than derive a new one.
      process.env.HOSTNAME = 'a-completely-different-host';
      const second = makeService();
      expect(second.getInstanceId()).toBe(id1);
    });

    it('derives a random uuid when no infrastructure identifiers are set', () => {
      for (const k of ['DB_HOST', 'DB_PORT', 'STORAGE_URL', 'HOSTNAME']) delete process.env[k];

      const id = makeService().getInstanceId();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('derives a stable hash from infra identifiers when nothing is persisted', () => {
      delete process.env.HOSTNAME;
      process.env.DB_HOST = 'db.internal';
      process.env.DB_PORT = '6379';

      const idA = makeService().getInstanceId();
      // Wipe the persisted file: identical infra inputs must reproduce the hash.
      rmSync(join(dataDir, 'instance-id'), { force: true });
      const idB = makeService().getInstanceId();

      expect(idB).toBe(idA);
      expect(idA).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('collectStats ephemerality signals', () => {
    let dataDir: string;

    const makeService = () =>
      new LicenseService({ get: jest.fn() } as unknown as ConfigService, mockTelemetryClient);

    const statsFromPing = async (): Promise<Record<string, unknown>> => {
      const svc = makeService();
      await svc.onModuleInit();
      await flushPromises();
      svc.onModuleDestroy();
      return JSON.parse(mockFetch.mock.calls[0][1].body).stats;
    };

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'betterdb-license-'));
      process.env.BETTERDB_DATA_DIR = dataDir;
      process.env.BETTERDB_TELEMETRY = 'false';
      delete process.env.BETTERDB_LICENSE_KEY;
      mockFetch.mockResolvedValue(
        createMockResponse({ valid: true, tier: 'community', expiresAt: null }),
      );
    });

    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('flags CI runs and container-id hostnames', async () => {
      process.env.CI = 'true';
      process.env.HOSTNAME = 'a1b2c3d4e5f6'; // Docker's default 12-hex short id

      const stats = await statsFromPing();
      expect(stats.ci).toBe(true);
      expect(stats.hostnameIsContainerId).toBe(true);
    });

    it('reports non-CI, human-named hosts as such', async () => {
      for (const k of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD'])
        delete process.env[k];
      process.env.HOSTNAME = 'prod-monitor-01';

      const stats = await statsFromPing();
      expect(stats.ci).toBe(false);
      expect(stats.hostnameIsContainerId).toBe(false);
    });

    it('detects kubernetes via the downward-API service host', async () => {
      process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';

      const stats = await statsFromPing();
      expect(stats.container).toBe('kubernetes');

      delete process.env.KUBERNETES_SERVICE_HOST;
    });
  });
});
