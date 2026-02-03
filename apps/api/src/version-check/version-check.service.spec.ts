import { Test, TestingModule } from '@nestjs/testing';
import { VersionCheckService } from './version-check.service';

describe('VersionCheckService', () => {
  let service: VersionCheckService;
  const originalEnv = process.env;

  beforeEach(async () => {
    // Reset environment
    process.env = { ...originalEnv };
    process.env.APP_VERSION = '0.1.0';

    const module: TestingModule = await Test.createTestingModule({
      providers: [VersionCheckService],
    }).compile();

    service = module.get<VersionCheckService>(VersionCheckService);
  });

  afterEach(() => {
    // Clean up intervals
    service.onModuleDestroy();
    // Restore original env
    process.env = originalEnv;
  });

  describe('getCurrentVersion', () => {
    it('should return current version from APP_VERSION', () => {
      expect(service.getCurrentVersion()).toBe('0.1.0');
    });
  });

  describe('isUpdateAvailable', () => {
    it('should detect update available when latest is newer', () => {
      service.setLatestVersionFromEntitlement('0.2.0');
      expect(service.isUpdateAvailable()).toBe(true);
    });

    it('should not flag update when on latest version', () => {
      service.setLatestVersionFromEntitlement('0.1.0');
      expect(service.isUpdateAvailable()).toBe(false);
    });

    it('should not flag update when on newer version', () => {
      service.setLatestVersionFromEntitlement('0.0.9');
      expect(service.isUpdateAvailable()).toBe(false);
    });

    it('should handle v-prefixed versions', () => {
      service.setLatestVersionFromEntitlement('v0.2.0');
      expect(service.isUpdateAvailable()).toBe(true);
    });

    it('should ignore invalid versions', () => {
      service.setLatestVersionFromEntitlement('not-a-version');
      expect(service.isUpdateAvailable()).toBe(false);
    });

    it('should return false when latestVersion is null', () => {
      expect(service.isUpdateAvailable()).toBe(false);
    });
  });

  describe('getVersionInfo', () => {
    it('should return complete version info object', () => {
      service.setLatestVersionFromEntitlement('0.2.0', 'https://example.com/release');

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
  });

  describe('setLatestVersionFromEntitlement', () => {
    it('should set release URL from entitlement', () => {
      service.setLatestVersionFromEntitlement('0.2.0', 'https://custom-url.com/release');

      const info = service.getVersionInfo();
      expect(info.releaseUrl).toBe('https://custom-url.com/release');
    });

    it('should generate default release URL when not provided', () => {
      service.setLatestVersionFromEntitlement('0.2.0');

      const info = service.getVersionInfo();
      expect(info.releaseUrl).toBe(
        'https://github.com/betterdb-io/betterdb-monitor/releases/tag/v0.2.0',
      );
    });

    it('should update checkedAt timestamp', () => {
      const before = Date.now();
      service.setLatestVersionFromEntitlement('0.2.0');
      const after = Date.now();

      const info = service.getVersionInfo();
      expect(info.checkedAt).toBeGreaterThanOrEqual(before);
      expect(info.checkedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('version comparison edge cases', () => {
    it('should handle pre-release versions', () => {
      service.setLatestVersionFromEntitlement('0.2.0-beta.1');
      // Pre-release is considered older than release in semver
      expect(service.isUpdateAvailable()).toBe(true);
    });

    it('should handle major version bumps', () => {
      service.setLatestVersionFromEntitlement('1.0.0');
      expect(service.isUpdateAvailable()).toBe(true);
    });

    it('should handle patch version bumps', () => {
      service.setLatestVersionFromEntitlement('0.1.1');
      expect(service.isUpdateAvailable()).toBe(true);
    });
  });
});
