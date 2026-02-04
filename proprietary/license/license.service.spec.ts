import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LicenseService } from './license.service';

describe('LicenseService', () => {
  let service: LicenseService;
  const originalEnv = process.env;

  beforeEach(async () => {
    // Reset environment
    process.env = { ...originalEnv };
    process.env.APP_VERSION = '0.1.0';
    // Disable actual HTTP calls
    delete process.env.BETTERDB_LICENSE_KEY;

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
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  describe('Version Check', () => {
    describe('isUpdateAvailable', () => {
      it('should return false when latestVersion is null', () => {
        expect(service.isUpdateAvailable()).toBe(false);
      });

      it('should return false when currentVersion is unknown', () => {
        process.env.APP_VERSION = 'unknown';
        // Re-create service to pick up new env
        const newService = new (LicenseService as any)({ get: jest.fn() });
        expect(newService.isUpdateAvailable()).toBe(false);
      });

      it('should detect update available when latest is newer', () => {
        // Access private method via reflection for testing
        (service as any).setLatestVersion('0.2.0');
        expect(service.isUpdateAvailable()).toBe(true);
      });

      it('should not flag update when on latest version', () => {
        (service as any).setLatestVersion('0.1.0');
        expect(service.isUpdateAvailable()).toBe(false);
      });

      it('should not flag update when on newer version', () => {
        (service as any).setLatestVersion('0.0.9');
        expect(service.isUpdateAvailable()).toBe(false);
      });

      it('should handle v-prefixed versions', () => {
        (service as any).setLatestVersion('v0.2.0');
        expect(service.isUpdateAvailable()).toBe(true);
      });

      it('should ignore invalid versions', () => {
        (service as any).setLatestVersion('not-a-version');
        expect(service.isUpdateAvailable()).toBe(false);
      });

      it('should handle pre-release versions', () => {
        (service as any).setLatestVersion('0.2.0-beta.1');
        // Pre-release is considered older than release in semver
        expect(service.isUpdateAvailable()).toBe(true);
      });

      it('should handle major version bumps', () => {
        (service as any).setLatestVersion('1.0.0');
        expect(service.isUpdateAvailable()).toBe(true);
      });

      it('should handle patch version bumps', () => {
        (service as any).setLatestVersion('0.1.1');
        expect(service.isUpdateAvailable()).toBe(true);
      });
    });

    describe('getVersionInfo', () => {
      it('should return complete version info object when update available', () => {
        (service as any).setLatestVersion('0.2.0', 'https://example.com/release');

        const info = service.getVersionInfo();

        expect(info).toEqual({
          current: '0.1.0',
          latest: '0.2.0',
          updateAvailable: true,
          releaseUrl: 'https://example.com/release',
          checkedAt: expect.any(Number),
        });
      });

      it('should return info with null latest when not checked', () => {
        const info = service.getVersionInfo();

        expect(info).toEqual({
          current: '0.1.0',
          latest: null,
          updateAvailable: false,
          releaseUrl: null,
          checkedAt: null,
        });
      });

      it('should generate default release URL when not provided', () => {
        (service as any).setLatestVersion('0.2.0');

        const info = service.getVersionInfo();
        expect(info.releaseUrl).toBe(
          'https://github.com/betterdb-inc/monitor/releases/tag/v0.2.0',
        );
      });

      it('should update checkedAt timestamp', () => {
        const before = Date.now();
        (service as any).setLatestVersion('0.2.0');
        const after = Date.now();

        const info = service.getVersionInfo();
        expect(info.checkedAt).toBeGreaterThanOrEqual(before);
        expect(info.checkedAt).toBeLessThanOrEqual(after);
      });
    });

    describe('setLatestVersion', () => {
      it('should set release URL from parameter', () => {
        (service as any).setLatestVersion('0.2.0', 'https://custom-url.com/release');

        const info = service.getVersionInfo();
        expect(info.releaseUrl).toBe('https://custom-url.com/release');
      });

      it('should strip v prefix from version', () => {
        (service as any).setLatestVersion('v0.2.0');

        const info = service.getVersionInfo();
        expect(info.latest).toBe('0.2.0');
      });

      it('should not update state for invalid versions', () => {
        (service as any).setLatestVersion('invalid');

        const info = service.getVersionInfo();
        expect(info.latest).toBeNull();
        expect(info.checkedAt).toBeNull();
      });
    });
  });
});
