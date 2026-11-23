import { envSchema } from './env.schema';

describe('monitor capture env vars', () => {
  it('has defaults', () => {
    const parsed = envSchema.parse({});
    expect(parsed.MONITOR_CAPTURE_RECONCILE_ON_STARTUP).toBe(true);
    expect(parsed.MONITOR_MAX_BYTE_CAP).toBe(500 * 1024 * 1024);
    expect(parsed.MONITOR_MAX_LINE_CAP).toBe(50_000_000);
  });

  it.each(['false', '0', ' Off '])('disables reconcile for %s', (value) => {
    expect(
      envSchema.parse({ MONITOR_CAPTURE_RECONCILE_ON_STARTUP: value })
        .MONITOR_CAPTURE_RECONCILE_ON_STARTUP,
    ).toBe(false);
  });

  it('coerces caps and rejects non-positive values', () => {
    expect(envSchema.parse({ MONITOR_MAX_BYTE_CAP: '1000' }).MONITOR_MAX_BYTE_CAP).toBe(1000);
    expect(() => envSchema.parse({ MONITOR_MAX_LINE_CAP: '0' })).toThrow();
    expect(() => envSchema.parse({ MONITOR_MAX_BYTE_CAP: 'abc' })).toThrow();
  });
});
