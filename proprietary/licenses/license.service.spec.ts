import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LicenseService } from './license.service';

describe('LicenseService', () => {
  let service: LicenseService;
  const originalEnv = process.env;

  beforeEach(async () => {
    // Reset environment
    process.env = { ...originalEnv };
    // These specs predate signed entitlement tokens and mock unsigned responses
    process.env.LICENSE_ALLOW_UNSIGNED = 'true';
    process.env.APP_VERSION = '0.1.0';
    // Disable actual HTTP calls
    delete process.env.BETTERDB_LICENSE_KEY;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LicenseService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'VERSION_CHECK_INTERVAL_MS') return 3600000;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<LicenseService>(LicenseService);
  });

  afterEach(() => {
    // Clean up heartbeat timer to prevent leaks
    service.onModuleDestroy();
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
        (service as any).setLatestVersion('0.2.0', 'https://github.com/betterdb-inc/monitor/releases/tag/v0.2.0');
        // Pin the launch environment — detection reads host state (/.dockerenv,
        // npm_config_user_agent) that varies across CI runners.
        (service as any).installMethod = 'docker';

        const info = service.getVersionInfo();

        expect(info).toEqual({
          current: '0.1.0',
          latest: '0.2.0',
          updateAvailable: true,
          releaseUrl: 'https://github.com/betterdb-inc/monitor/releases/tag/v0.2.0',
          checkedAt: expect.any(Number),
          versionCheckIntervalMs: 3600000,
          installMethod: 'docker',
          updateCommand: 'docker pull betterdb/monitor:latest',
          updateDocsUrl: 'https://docs.betterdb.com/updating',
        });
      });

      it('should return info with null latest when not checked', () => {
        (service as any).installMethod = 'unknown';

        const info = service.getVersionInfo();

        expect(info).toEqual({
          current: '0.1.0',
          latest: null,
          updateAvailable: false,
          releaseUrl: null,
          checkedAt: null,
          versionCheckIntervalMs: 3600000,
          installMethod: 'unknown',
          updateCommand: null,
          updateDocsUrl: 'https://docs.betterdb.com/updating',
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
      it('should keep a trusted release URL from parameter', () => {
        (service as any).setLatestVersion('0.2.0', 'https://www.betterdb.com/releases/0.2.0');

        const info = service.getVersionInfo();
        expect(info.releaseUrl).toBe('https://www.betterdb.com/releases/0.2.0');
      });

      it('should reject an untrusted release URL and derive the canonical one', () => {
        (service as any).setLatestVersion('0.2.0', 'https://evil.example/phish');

        const info = service.getVersionInfo();
        expect(info.releaseUrl).toBe('https://github.com/betterdb-inc/monitor/releases/tag/v0.2.0');
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

    describe('install-method detection', () => {
      const OLD_ENV = { ...process.env };

      afterEach(() => {
        process.env = { ...OLD_ENV };
        jest.restoreAllMocks();
      });

      // Isolate the package-manager branch: container detection runs first and
      // reads host state (/.dockerenv), which is truthy inside a Docker CI
      // runner and would otherwise short-circuit every user-agent assertion.
      function detectViaUserAgent(env: Record<string, string | undefined>): string {
        jest.spyOn(service as any, 'detectContainerRuntime').mockReturnValue(undefined);
        for (const key of ['npm_config_user_agent', 'npm_command']) {
          delete process.env[key];
        }
        Object.assign(process.env, env);
        (service as any).installMethod = null; // force fresh detection (result is cached)
        return (service as any).detectInstallMethod();
      }

      it('lets the container runtime win over the package manager', () => {
        jest.spyOn(service as any, 'detectContainerRuntime').mockReturnValue('kubernetes');
        process.env.npm_config_user_agent = 'pnpm/9.15.0 node/v20.0.0';
        (service as any).installMethod = null;
        expect((service as any).detectInstallMethod()).toBe('kubernetes');
      });

      it('maps npm/pnpm/yarn user agents to their package manager', () => {
        expect(detectViaUserAgent({ npm_config_user_agent: 'npm/9.6.7 node/v18.16.0' })).toBe('npm');
        expect(detectViaUserAgent({ npm_config_user_agent: 'pnpm/9.15.0 node/v20.0.0' })).toBe('pnpm');
        expect(detectViaUserAgent({ npm_config_user_agent: 'yarn/1.22.19 node/v18.0.0' })).toBe('yarn');
      });

      it('distinguishes npx from npm via npm_command=exec', () => {
        expect(
          detectViaUserAgent({ npm_config_user_agent: 'npm/9.6.7 node/v18.16.0', npm_command: 'exec' }),
        ).toBe('npx');
      });

      it('falls back to unknown when nothing is detectable', () => {
        expect(detectViaUserAgent({})).toBe('unknown');
      });

      it('caches the resolved method — env changes after first read are ignored', () => {
        detectViaUserAgent({ npm_config_user_agent: 'pnpm/9.15.0 node/v20.0.0' });
        process.env.npm_config_user_agent = 'yarn/1.22.19 node/v18.0.0';
        expect((service as any).detectInstallMethod()).toBe('pnpm');
      });
    });

    describe('buildUpdateCommand', () => {
      const cases: Array<[string, string | null]> = [
        ['docker', 'docker pull betterdb/monitor:latest'],
        ['podman', 'podman pull betterdb/monitor:latest'],
        ['npx', 'npx @betterdb/monitor@latest'],
        ['npm', 'npm install -g @betterdb/monitor@latest'],
        ['pnpm', 'pnpm add -g @betterdb/monitor@latest'],
        ['yarn', 'yarn global add @betterdb/monitor@latest'],
        ['kubernetes', null],
        ['unknown', null],
      ];

      it.each(cases)('maps %s to its upgrade command', (method, expected) => {
        expect((service as any).buildUpdateCommand(method)).toBe(expected);
      });
    });
  });
});
