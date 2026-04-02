import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelemetryClientFactory } from '../telemetry-client.factory';
import { NoopTelemetryClientAdapter } from '../adapters/noop-telemetry-client.adapter';
import { HttpTelemetryClientAdapter } from '../adapters/http-telemetry-client.adapter';
import { PosthogTelemetryClientAdapter } from '../adapters/posthog-telemetry-client.adapter';

function createConfigService(
  env: Record<string, string | boolean | undefined> = {},
): ConfigService {
  return {
    get: jest.fn(
      (key: string, defaultValue?: string | boolean) => env[key] ?? defaultValue,
    ),
  } as unknown as ConfigService;
}

describe('TelemetryClientFactory', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('should return NoopTelemetryClientAdapter for TELEMETRY_PROVIDER=noop', () => {
    const config = createConfigService({ TELEMETRY_PROVIDER: 'noop' });
    const factory = new TelemetryClientFactory(config);
    expect(factory.createTelemetryClient()).toBeInstanceOf(NoopTelemetryClientAdapter);
  });

  it('should return HttpTelemetryClientAdapter for TELEMETRY_PROVIDER=http', () => {
    const config = createConfigService({ TELEMETRY_PROVIDER: 'http' });
    const factory = new TelemetryClientFactory(config);
    expect(factory.createTelemetryClient()).toBeInstanceOf(HttpTelemetryClientAdapter);
  });

  it('should return PosthogTelemetryClientAdapter for TELEMETRY_PROVIDER=posthog with API key', () => {
    const config = createConfigService({
      TELEMETRY_PROVIDER: 'posthog',
      POSTHOG_API_KEY: 'phc_test',
    });
    const factory = new TelemetryClientFactory(config);
    expect(factory.createTelemetryClient()).toBeInstanceOf(PosthogTelemetryClientAdapter);
  });

  it('should return NoopTelemetryClientAdapter when BETTERDB_TELEMETRY is boolean false', () => {
    const config = createConfigService({
      TELEMETRY_PROVIDER: 'posthog',
      BETTERDB_TELEMETRY: false,
      POSTHOG_API_KEY: 'phc_test',
    });
    const factory = new TelemetryClientFactory(config);
    expect(factory.createTelemetryClient()).toBeInstanceOf(NoopTelemetryClientAdapter);
  });

  it('should return NoopTelemetryClientAdapter when BETTERDB_TELEMETRY is string "false"', () => {
    const config = createConfigService({
      TELEMETRY_PROVIDER: 'posthog',
      BETTERDB_TELEMETRY: 'false',
      POSTHOG_API_KEY: 'phc_test',
    });
    const factory = new TelemetryClientFactory(config);
    expect(factory.createTelemetryClient()).toBeInstanceOf(NoopTelemetryClientAdapter);
  });

  it('should fall back to NoopTelemetryClientAdapter and warn when posthog key is missing', () => {
    const config = createConfigService({ TELEMETRY_PROVIDER: 'posthog' });
    const factory = new TelemetryClientFactory(config);
    expect(factory.createTelemetryClient()).toBeInstanceOf(NoopTelemetryClientAdapter);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('POSTHOG_API_KEY'),
    );
  });

  it('should fall back to NoopTelemetryClientAdapter and warn for unknown provider', () => {
    const config = createConfigService({ TELEMETRY_PROVIDER: 'datadog' });
    const factory = new TelemetryClientFactory(config);
    expect(factory.createTelemetryClient()).toBeInstanceOf(NoopTelemetryClientAdapter);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown TELEMETRY_PROVIDER'),
    );
  });

  it('should fall back to NoopTelemetryClientAdapter when ENTITLEMENT_URL path is invalid for http', () => {
    const config = createConfigService({
      TELEMETRY_PROVIDER: 'http',
      ENTITLEMENT_URL: 'https://example.com/api/v1/other',
    });
    const factory = new TelemetryClientFactory(config);
    expect(factory.createTelemetryClient()).toBeInstanceOf(NoopTelemetryClientAdapter);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not end with "/entitlements"'),
    );
  });
});
