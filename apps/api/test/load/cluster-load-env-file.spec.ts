jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const { basename } = jest.requireActual('path');
  const isEnvFile = (path: unknown) => basename(String(path)) === '.env';
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
  const VARIABLES = ['JEST_WORKER_ID', 'CLUSTER_LOAD_PROBE'];
  const kept = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of VARIABLES) {
      kept.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of kept) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
