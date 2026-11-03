jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const isEnvFile = (path: unknown) => String(path).endsWith('/.env');
  return {
    ...actual,
    existsSync: (path: string) => isEnvFile(path) || actual.existsSync(path),
    readFileSync: (path: string, ...rest: unknown[]) =>
      isEnvFile(path)
        ? [
            'CONFIG_MODULE_PROBE=from-env-file',
            'BETTERDB_LICENSE_KEY=from-env-file',
            'CLOUD_MODE=true',
            'ENTITLEMENT_URL=https://entitlements.example.com',
          ].join('\n')
        : actual.readFileSync(path, ...rest),
  };
});

const settle = async (): Promise<void> => {
  await jest.isolateModulesAsync(async () => {
    const { ConfigModule } = await import('./config.module');
    await Promise.all(Reflect.getMetadata('imports', ConfigModule));
  });
};

const blocking = process.env.BETTERDB_TEST_KEEP_ENV !== 'true';

const envFileKeys = ['CONFIG_MODULE_PROBE', 'BETTERDB_LICENSE_KEY', 'CLOUD_MODE', 'ENTITLEMENT_URL'];

const initial = Object.fromEntries(envFileKeys.map((key) => [key, process.env[key]]));

describe('ConfigModule', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(envFileKeys.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    for (const key of envFileKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('restores the keys the env file filled in', async () => {
    delete process.env.BETTERDB_LICENSE_KEY;
    await settle();
    expect(process.env.BETTERDB_LICENSE_KEY).toBe('from-env-file');
  });

  it('leaves no env file keys behind for later tests', () => {
    for (const key of envFileKeys) expect(process.env[key]).toBe(initial[key]);
  });

  it('loads the repo-root env file under jest', async () => {
    await settle();
    expect(process.env.CONFIG_MODULE_PROBE).toBe('from-env-file');
  });

  (blocking ? it : it.skip)('keeps the license and cloud keys the test setup blocked', async () => {
    await settle();
    expect(process.env.BETTERDB_LICENSE_KEY).toBe('');
    expect(process.env.CLOUD_MODE).toBe('');
    expect(process.env.ENTITLEMENT_URL).toBe('http://127.0.0.1:9/api/v1/entitlements');
  });
});
