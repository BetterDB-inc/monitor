jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const isEnvFile = (path: unknown) => String(path).endsWith('/.env');
  return {
    ...actual,
    existsSync: (path: string) => isEnvFile(path) || actual.existsSync(path),
    readFileSync: (path: string, ...rest: unknown[]) =>
      isEnvFile(path) ? 'CLUSTER_LOAD_PROBE=from-env-file' : actual.readFileSync(path, ...rest),
  };
});

const loadConfig = async (prepare: 'as the load test does' | 'as the app does'): Promise<void> => {
  await jest.isolateModulesAsync(async () => {
    if (prepare === 'as the load test does') {
      const { ignoreEnvFile } = await import('../../scripts/cluster-load/env-file');
      ignoreEnvFile();
    }
    const { ConfigModule } = await import('../../src/config/config.module');
    await Promise.all(Reflect.getMetadata('imports', ConfigModule));
  });
};

describe('cluster load test, repo env file', () => {
  const jestWorkerId = process.env.JEST_WORKER_ID;

  beforeEach(() => {
    delete process.env.JEST_WORKER_ID;
  });

  afterEach(() => {
    process.env.JEST_WORKER_ID = jestWorkerId;
    delete process.env.CLUSTER_LOAD_PROBE;
  });

  it('would read the repo env file like the app does', async () => {
    await loadConfig('as the app does');
    expect(process.env.CLUSTER_LOAD_PROBE).toBe('from-env-file');
  });

  it('keeps the repo env file out of a run', async () => {
    await loadConfig('as the load test does');
    expect(process.env.CLUSTER_LOAD_PROBE).toBeUndefined();
  });
});
