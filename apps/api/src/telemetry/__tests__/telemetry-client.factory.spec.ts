import { ConfigService } from '@nestjs/config';
import { TelemetryClientFactory } from '../telemetry-client.factory';
import { NoopTelemetryClientAdapter } from '../adapters/noop-telemetry-client.adapter';

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
  it('should return NoopAdapter for TELEMETRY_PROVIDER=noop', () => {
    const config = createConfigService({ TELEMETRY_PROVIDER: 'noop' });
    const factory = new TelemetryClientFactory(config);
    const adapter = factory.createTelemetryClient();
    expect(adapter).toBeInstanceOf(NoopTelemetryClientAdapter);
  });

  it('should return NoopAdapter when BETTERDB_TELEMETRY is false regardless of provider', () => {
    const config = createConfigService({
      TELEMETRY_PROVIDER: 'posthog',
      BETTERDB_TELEMETRY: false,
      POSTHOG_API_KEY: 'phc_test',
    });
    const factory = new TelemetryClientFactory(config);
    const adapter = factory.createTelemetryClient();
    expect(adapter).toBeInstanceOf(NoopTelemetryClientAdapter);
  });

  it('should fall back to NoopAdapter with warning when posthog is selected but POSTHOG_API_KEY is missing', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const config = createConfigService({ TELEMETRY_PROVIDER: 'posthog' });
    const factory = new TelemetryClientFactory(config);
    const adapter = factory.createTelemetryClient();
    expect(adapter).toBeInstanceOf(NoopTelemetryClientAdapter);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('POSTHOG_API_KEY'),
    );
    warnSpy.mockRestore();
  });

  it('should fall back to noop with warning when no env vars are set (default is posthog, but key is missing)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const config = createConfigService({});
    const factory = new TelemetryClientFactory(config);
    const adapter = factory.createTelemetryClient();
    expect(adapter).toBeInstanceOf(NoopTelemetryClientAdapter);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('POSTHOG_API_KEY'),
    );
    warnSpy.mockRestore();
  });
});
