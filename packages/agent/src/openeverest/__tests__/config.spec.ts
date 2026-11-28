import { loadOpenEverestConfig, integerSetting } from '../config';

const base = { KUBERNETES_SERVICE_HOST: '10.0.0.1' };

describe('loadOpenEverestConfig', () => {
  it('uses the defaults when the numeric settings are unset or blank', () => {
    const config = loadOpenEverestConfig({ ...base, PORT: '', BETTERDB_REDISCOVER_INTERVAL_MS: ' ' });
    expect(config.port).toBe(8080);
    expect(config.rediscoverIntervalMs).toBe(60_000);
  });

  it('accepts integers in range', () => {
    const config = loadOpenEverestConfig({ ...base, PORT: '9090', BETTERDB_REDISCOVER_INTERVAL_MS: '10000' });
    expect(config.port).toBe(9090);
    expect(config.rediscoverIntervalMs).toBe(10_000);
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '80a'],
    ['PORT', '8.5'],
    ['BETTERDB_REDISCOVER_INTERVAL_MS', '5000'],
    ['BETTERDB_REDISCOVER_INTERVAL_MS', '36000000'],
    ['BETTERDB_REDISCOVER_INTERVAL_MS', 'soon'],
  ])('fails fast, naming the variable, for %s=%s', (name, value) => {
    expect(() => loadOpenEverestConfig({ ...base, [name]: value })).toThrow(new RegExp(`^${name} must be an integer between`));
  });

  it('reads the fallback settings only when both URL and token are present', () => {
    expect(loadOpenEverestConfig({ ...base, BETTERDB_CLOUD_URL: 'wss://x/agent/ws' }).fallbackSettings).toBeUndefined();
    expect(loadOpenEverestConfig({ ...base, BETTERDB_CLOUD_URL: 'wss://x/agent/ws', BETTERDB_TOKEN: 't' }).fallbackSettings)
      .toEqual({ url: 'wss://x/agent/ws', token: 't' });
  });
});

describe('integerSetting', () => {
  it('trims and bounds', () => {
    expect(integerSetting({ X: ' 42 ' }, 'X', 1, 0, 100)).toBe(42);
    expect(() => integerSetting({ X: '-1' }, 'X', 1, 0, 100)).toThrow('X must be an integer between 0 and 100 (got "-1")');
  });
});
