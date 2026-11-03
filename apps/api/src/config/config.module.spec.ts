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

describe('ConfigModule', () => {
  afterEach(() => {
    delete process.env.CONFIG_MODULE_PROBE;
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
