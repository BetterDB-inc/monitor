import { envSchema } from './env.schema';

const CAP_KEYS = ['MONITOR_MAX_BYTE_CAP', 'MONITOR_MAX_LINE_CAP'] as const;

/** Loads the capture service's cap constants in a fresh module registry with the given env. */
function loadServiceCaps(env: Partial<Record<(typeof CAP_KEYS)[number], string>>): {
  MAX_BYTE_CAP: number;
  MAX_LINE_CAP: number;
} {
  const saved = Object.fromEntries(CAP_KEYS.map((k) => [k, process.env[k]]));
  for (const k of CAP_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    let caps!: { MAX_BYTE_CAP: number; MAX_LINE_CAP: number };
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      caps = require('../monitor/monitor-capture.service');
    });
    return { MAX_BYTE_CAP: caps.MAX_BYTE_CAP, MAX_LINE_CAP: caps.MAX_LINE_CAP };
  } finally {
    for (const k of CAP_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('monitor capture env vars', () => {
  it('has defaults', () => {
    const parsed = envSchema.parse({});
    // Unset means "decide from STORAGE_TYPE" (see resolveReconcileOnStartup).
    expect(parsed.MONITOR_CAPTURE_RECONCILE_ON_STARTUP).toBeUndefined();
    expect(parsed.MONITOR_MAX_BYTE_CAP).toBe(500 * 1024 * 1024);
    expect(parsed.MONITOR_MAX_LINE_CAP).toBe(50_000_000);
  });

  it.each(['false', '0', ' Off '])('disables reconcile for %s', (value) => {
    expect(
      envSchema.parse({ MONITOR_CAPTURE_RECONCILE_ON_STARTUP: value })
        .MONITOR_CAPTURE_RECONCILE_ON_STARTUP,
    ).toBe(false);
  });

  it('enables reconcile for an explicit true', () => {
    expect(
      envSchema.parse({ MONITOR_CAPTURE_RECONCILE_ON_STARTUP: 'true' })
        .MONITOR_CAPTURE_RECONCILE_ON_STARTUP,
    ).toBe(true);
  });

  it('coerces caps and rejects non-positive values', () => {
    expect(envSchema.parse({ MONITOR_MAX_BYTE_CAP: '1000' }).MONITOR_MAX_BYTE_CAP).toBe(1000);
    expect(() => envSchema.parse({ MONITOR_MAX_LINE_CAP: '0' })).toThrow();
    expect(() => envSchema.parse({ MONITOR_MAX_BYTE_CAP: 'abc' })).toThrow();
  });

  it('agrees with the capture service on the default maximums', () => {
    const parsed = envSchema.parse({});
    expect(loadServiceCaps({})).toEqual({
      MAX_BYTE_CAP: parsed.MONITOR_MAX_BYTE_CAP,
      MAX_LINE_CAP: parsed.MONITOR_MAX_LINE_CAP,
    });
  });

  it('parses explicit maximums the same way the schema does, exponent notation included', () => {
    const env = { MONITOR_MAX_BYTE_CAP: '1e8', MONITOR_MAX_LINE_CAP: '2000' };
    const parsed = envSchema.parse(env);
    expect(loadServiceCaps(env)).toEqual({
      MAX_BYTE_CAP: parsed.MONITOR_MAX_BYTE_CAP,
      MAX_LINE_CAP: parsed.MONITOR_MAX_LINE_CAP,
    });
    expect(parsed.MONITOR_MAX_BYTE_CAP).toBe(100_000_000);
  });
});
