import { TelemetryPort } from '../../common/interfaces/telemetry-port.interface';
import { NoopTelemetryClientAdapter } from '../adapters/noop-telemetry-client.adapter';

describe('NoopTelemetryClientAdapter', () => {
  let adapter: TelemetryPort;

  beforeEach(() => {
    adapter = new NoopTelemetryClientAdapter();
  });

  it('should implement capture without side effects', () => {
    expect(() =>
      adapter.capture({ distinctId: 'test', event: 'app_start' }),
    ).not.toThrow();
  });

  it('should implement identify without side effects', () => {
    expect(() =>
      adapter.identify('test', { tier: 'community' }),
    ).not.toThrow();
  });

  it('should implement shutdown without side effects', async () => {
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });
});
