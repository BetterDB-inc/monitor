import { ConfigService } from '@nestjs/config';
import { TelemetryController } from '../telemetry.controller';
import { UsageTelemetryService } from '../usage-telemetry.service';
import { TelemetryPort } from '../../common/interfaces/telemetry-port.interface';
import { LicenseService } from '@proprietary/licenses';

function createMockConfigService(
  env: Record<string, string | boolean | undefined> = {},
): ConfigService {
  return {
    get: jest.fn(
      (key: string, defaultValue?: string | boolean) => env[key] ?? defaultValue,
    ),
  } as unknown as ConfigService;
}

const mockAdapter: TelemetryPort = {
  capture: jest.fn(),
  identify: jest.fn(),
  shutdown: jest.fn().mockResolvedValue(undefined),
};

function createController(
  configService: ConfigService,
  licenseService?: Partial<LicenseService>,
): TelemetryController {
  const service = new UsageTelemetryService(
    mockAdapter,
    configService,
    licenseService as LicenseService | undefined,
  );
  return new TelemetryController(
    service,
    configService,
    licenseService as LicenseService | undefined,
  );
}

describe('GET /telemetry/config', () => {
  it('should return telemetry config with posthog provider and API key', () => {
    const configService = createMockConfigService({
      TELEMETRY_PROVIDER: 'posthog',
      POSTHOG_API_KEY: 'phc_test_key',
      POSTHOG_HOST: 'https://ph.example.com',
      BETTERDB_TELEMETRY: true,
    });
    const licenseService = {
      getInstanceId: jest.fn().mockReturnValue('test-instance-id'),
    };

    const controller = createController(configService, licenseService);
    const config = controller.getConfig();

    expect(config).toEqual({
      instanceId: 'test-instance-id',
      telemetryEnabled: true,
      provider: 'posthog',
      posthogApiKey: 'phc_test_key',
      posthogHost: 'https://ph.example.com',
    });
  });

  it('should omit posthog fields when provider is not posthog', () => {
    const configService = createMockConfigService({
      TELEMETRY_PROVIDER: 'http',
      BETTERDB_TELEMETRY: true,
    });

    const controller = createController(configService);
    const config = controller.getConfig();

    expect(config).toEqual({
      instanceId: '',
      telemetryEnabled: true,
      provider: 'http',
    });
    expect(config).not.toHaveProperty('posthogApiKey');
    expect(config).not.toHaveProperty('posthogHost');
  });

  it('should return telemetryEnabled false when BETTERDB_TELEMETRY is boolean false', () => {
    const configService = createMockConfigService({
      TELEMETRY_PROVIDER: 'noop',
      BETTERDB_TELEMETRY: false,
    });

    const controller = createController(configService);
    expect(controller.getConfig().telemetryEnabled).toBe(false);
  });

  it('should return telemetryEnabled false when BETTERDB_TELEMETRY is string "false"', () => {
    const configService = createMockConfigService({
      TELEMETRY_PROVIDER: 'noop',
      BETTERDB_TELEMETRY: 'false',
    });

    const controller = createController(configService);
    expect(controller.getConfig().telemetryEnabled).toBe(false);
  });

  it('should return empty instanceId when licenseService is absent', () => {
    const configService = createMockConfigService({
      TELEMETRY_PROVIDER: 'posthog',
      POSTHOG_API_KEY: 'phc_key',
    });

    const controller = createController(configService);
    const config = controller.getConfig();

    expect(config.instanceId).toBe('');
  });
});
