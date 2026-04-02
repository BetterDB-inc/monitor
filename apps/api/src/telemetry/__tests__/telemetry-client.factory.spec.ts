import { ConfigService } from '@nestjs/config';
import { TelemetryClientFactory } from '../telemetry-client.factory';
import { NoopTelemetryAdapter } from '../adapters/noop-telemetry.adapter';

function createConfigService(env: Record<string, string | undefined> = {}): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: string) => env[key] ?? defaultValue),
  } as unknown as ConfigService;
}

describe('TelemetryClientFactory', () => {
  it('should return NoopAdapter for TELEMETRY_PROVIDER=noop', () => {
    const config = createConfigService({ TELEMETRY_PROVIDER: 'noop' });
    const factory = new TelemetryClientFactory(config);
    const adapter = factory.createTelemetryClient();
    expect(adapter).toBeInstanceOf(NoopTelemetryAdapter);
  });

  it('should return NoopAdapter when BETTERDB_TELEMETRY is false regardless of provider', () => {
    const config = createConfigService({
      TELEMETRY_PROVIDER: 'posthog',
      BETTERDB_TELEMETRY: 'false',
      POSTHOG_API_KEY: 'phc_test',
    });
    const factory = new TelemetryClientFactory(config);
    const adapter = factory.createTelemetryClient();
    expect(adapter).toBeInstanceOf(NoopTelemetryAdapter);
  });

  it('should fall back to NoopAdapter with warning when posthog is selected but POSTHOG_API_KEY is missing', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const config = createConfigService({ TELEMETRY_PROVIDER: 'posthog' });
    const factory = new TelemetryClientFactory(config);
    const adapter = factory.createTelemetryClient();
    expect(adapter).toBeInstanceOf(NoopTelemetryAdapter);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('POSTHOG_API_KEY'),
    );
    warnSpy.mockRestore();
  });

  it('should default to posthog provider when TELEMETRY_PROVIDER is not set', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const config = createConfigService({});
    const factory = new TelemetryClientFactory(config);
    const adapter = factory.createTelemetryClient();
    // Without POSTHOG_API_KEY, falls back to noop with warning
    expect(adapter).toBeInstanceOf(NoopTelemetryAdapter);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
