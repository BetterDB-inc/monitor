jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const isEnvFile = (path: unknown) => String(path).endsWith('/.env');
  return {
    ...actual,
    existsSync: (path: string) => isEnvFile(path) || actual.existsSync(path),
    readFileSync: (path: string, ...rest: unknown[]) =>
      isEnvFile(path) ? 'CONFIG_MODULE_PROBE=from-env-file' : actual.readFileSync(path, ...rest),
  };
});

const settle = async (): Promise<void> => {
  await jest.isolateModulesAsync(async () => {
    const { ConfigModule } = await import('./config.module');
    await Promise.all(Reflect.getMetadata('imports', ConfigModule));
  });
};

describe('ConfigModule', () => {
  const jestWorkerId = process.env.JEST_WORKER_ID;

  afterEach(() => {
    process.env.JEST_WORKER_ID = jestWorkerId;
    delete process.env.CONFIG_MODULE_PROBE;
  });

  it('leaves the repo-root env file out of jest runs', async () => {
    await settle();
    expect(process.env.CONFIG_MODULE_PROBE).toBeUndefined();
  });

  it('loads the repo-root env file outside jest', async () => {
    delete process.env.JEST_WORKER_ID;
    await settle();
    expect(process.env.CONFIG_MODULE_PROBE).toBe('from-env-file');
  });
});
