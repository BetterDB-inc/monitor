import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  applyConnectionSettings,
  applyEnvFile,
  applyTestDbOverrides,
  BLOCKED_KEYS,
  KEEP_ENV,
  loadEnvFile,
  ROOT_ENV_FILE,
  STUB_ENTITLEMENT_URL,
} from './test-env';

const writeEnvFile = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'test-env-')), '.env');
  writeFileSync(path, contents);
  return path;
};

const DEV_ENV_FILE = ['DB_HOST=dev-host', 'DB_PORT=6380', 'DB_PASSWORD=dev-pass', 'DB_TLS=true'].join('\n');

describe('test env', () => {
  describe('applyEnvFile', () => {
    it('fills the connection settings the shell leaves unset', () => {
      const env: NodeJS.ProcessEnv = {};
      applyEnvFile(
        ['DB_HOST=db.local', 'DB_TLS=true', 'DB_USERNAME=admin', 'DB_TLS_CA_FILE=/ca.pem'].join('\n'),
        env,
      );
      expect(env).toEqual({
        DB_HOST: 'db.local',
        DB_TLS: 'true',
        DB_USERNAME: 'admin',
        DB_TLS_CA_FILE: '/ca.pem',
      });
    });

    it('keeps a value the shell already set', () => {
      const env: NodeJS.ProcessEnv = { DB_HOST: 'from-shell' };
      applyEnvFile('DB_HOST=from-env-file', env);
      expect(env.DB_HOST).toBe('from-shell');
    });

    it('ignores every key outside the connection settings', () => {
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
        'STORAGE_URL',
        'DB_SOMETHING_NEW',
      ];
      applyEnvFile(keys.map((key) => `${key}=from-env-file`).join('\n'), env);
      expect(env).toEqual({});
    });
  });

  describe('loadEnvFile', () => {
    it('applies the connection settings from a file on disk', () => {
      const env: NodeJS.ProcessEnv = {};
      loadEnvFile(writeEnvFile('DB_HOST=db.local\nWORKSPACE_DISABLED=true\n'), env);
      expect(env).toEqual({ DB_HOST: 'db.local' });
    });

    it('does nothing when the file is missing', () => {
      const env: NodeJS.ProcessEnv = {};
      loadEnvFile(join(tmpdir(), 'no-such-dir', '.env'), env);
      expect(env).toEqual({});
    });
  });

  it('reads the env file at the repo root', () => {
    expect(existsSync(join(dirname(ROOT_ENV_FILE), 'pnpm-workspace.yaml'))).toBe(true);
  });

  describe('applyTestDbOverrides', () => {
    it('takes the test database settings ahead of the env file', () => {
      const env: NodeJS.ProcessEnv = {
        TEST_DB_HOST: 'test-host',
        TEST_DB_PORT: '6391',
        TEST_DB_PASSWORD: 'test-pass',
      };
      applyTestDbOverrides(env);
      applyEnvFile('DB_HOST=env-host\nDB_PORT=6379\nDB_PASSWORD=env-pass', env);
      expect([env.DB_HOST, env.DB_PORT, env.DB_PASSWORD]).toEqual(['test-host', '6391', 'test-pass']);
    });

    it('keeps a database setting the shell already set', () => {
      const env: NodeJS.ProcessEnv = { DB_PORT: '7000', TEST_DB_PORT: '6391' };
      applyTestDbOverrides(env);
      expect(env.DB_PORT).toBe('7000');
    });
  });

  describe('applyConnectionSettings', () => {
    it('points at the test container and skips the env file by default', () => {
      const env: NodeJS.ProcessEnv = {};
      applyConnectionSettings(env, writeEnvFile(DEV_ENV_FILE));
      expect(env).toEqual({ DB_HOST: 'localhost', DB_PORT: '6390', DB_PASSWORD: 'devpassword' });
    });

    it('lets the env file win over the test defaults when opted in', () => {
      const env: NodeJS.ProcessEnv = { BETTERDB_TEST_USE_ENV_FILE: 'true' };
      applyConnectionSettings(env, writeEnvFile(DEV_ENV_FILE));
      expect(env).toEqual({
        BETTERDB_TEST_USE_ENV_FILE: 'true',
        DB_HOST: 'dev-host',
        DB_PORT: '6380',
        DB_PASSWORD: 'dev-pass',
        DB_TLS: 'true',
      });
    });

    it('keeps the shell and TEST_DB_* values ahead of an opted-in env file', () => {
      const env: NodeJS.ProcessEnv = {
        BETTERDB_TEST_USE_ENV_FILE: 'true',
        DB_HOST: 'shell-host',
        TEST_DB_PORT: '6391',
      };
      applyConnectionSettings(env, writeEnvFile(DEV_ENV_FILE));
      expect([env.DB_HOST, env.DB_PORT, env.DB_PASSWORD]).toEqual(['shell-host', '6391', 'dev-pass']);
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
