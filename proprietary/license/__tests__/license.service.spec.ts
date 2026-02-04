import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LicenseService } from '../license.service';

describe('LicenseService', () => {
  let service: LicenseService;
  let mockFetch: jest.SpyInstance;

  const originalEnv = process.env;

  const flushPromises = () => new Promise(process.nextTick);

  const createMockResponse = (data: Record<string, unknown>, ok = true) => ({
    ok,
    json: jest.fn().mockResolvedValue(data),
  });

  beforeEach(async () => {
    jest.resetModules();
    process.env = { ...originalEnv };

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
      expect(callBody.stats).toHaveProperty('platform');
      expect(callBody.stats).toHaveProperty('arch');
      expect(callBody.stats).toHaveProperty('nodeVersion');
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
});
