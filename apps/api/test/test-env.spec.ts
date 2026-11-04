import { applyEnvFile, BLOCKED_KEYS, KEEP_ENV, STUB_ENTITLEMENT_URL } from './test-env';

describe('test env', () => {
  describe('applyEnvFile', () => {
    it('fills the DB and storage settings the shell leaves unset', () => {
      const env: NodeJS.ProcessEnv = {};
      applyEnvFile(
        ['DB_HOST=db.local', 'DB_TLS=true', 'DB_USERNAME=admin', 'STORAGE_URL=postgres://db/x'].join('\n'),
        env,
      );
      expect(env).toEqual({
        DB_HOST: 'db.local',
        DB_TLS: 'true',
        DB_USERNAME: 'admin',
        STORAGE_URL: 'postgres://db/x',
      });
    });

    it('keeps a value the shell already set', () => {
      const env: NodeJS.ProcessEnv = { DB_HOST: 'from-shell' };
      applyEnvFile('DB_HOST=from-env-file', env);
      expect(env.DB_HOST).toBe('from-shell');
    });

    it('ignores every key outside the DB and storage settings', () => {
      const env: NodeJS.ProcessEnv = {};
      const keys = [
        ...BLOCKED_KEYS,
        'ENTITLEMENT_URL',
        'WORKSPACE_DISABLED',
        'AUTH_SECRET',
        'CVE_ENABLED',
        'PROMETHEUS_METRICS_TOKEN',
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        'STORAGE_TYPE',
      ];
      applyEnvFile(keys.map((key) => `${key}=from-env-file`).join('\n'), env);
      expect(env).toEqual({});
    });
  });

  it('blocks the license, cloud and schema keys', () => {
    expect([...BLOCKED_KEYS].sort()).toEqual([
      'BETTERDB_LICENSE_KEY',
      'BETTERDB_OFFLINE_LICENSE',
      'BETTERDB_OFFLINE_LICENSE_FILE',
      'CLOUD_MODE',
      'DB_SCHEMA',
    ]);
  });

  (KEEP_ENV ? it.skip : it)('clears every blocked key and stubs the entitlement host', () => {
    for (const key of BLOCKED_KEYS) expect(process.env[key]).toBeUndefined();
    expect(process.env.ENTITLEMENT_URL).toBe(STUB_ENTITLEMENT_URL);
  });
});
