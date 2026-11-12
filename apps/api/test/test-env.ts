import { parse } from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const KEEP_ENV = process.env.BETTERDB_TEST_KEEP_ENV === 'true';

export const STUB_ENTITLEMENT_URL = 'http://127.0.0.1:9/api/v1/entitlements';

export const BLOCKED_KEYS = [
  'BETTERDB_LICENSE_KEY',
  'BETTERDB_OFFLINE_LICENSE',
  'BETTERDB_OFFLINE_LICENSE_FILE',
  'CLOUD_MODE',
  'DB_SCHEMA',
] as const;

export const ROOT_ENV_FILE = join(__dirname, '../../..', '.env');

const ENV_FILE_KEYS = new Set([
  'DB_HOST',
  'DB_PORT',
  'DB_PASSWORD',
  'DB_USERNAME',
  'DB_TYPE',
  'DB_AUTH_MODE',
  'DB_TLS',
  'DB_TLS_CA_FILE',
  'DB_TLS_CERT_FILE',
  'DB_TLS_KEY_FILE',
  'DB_TLS_KEY_PASSPHRASE',
]);

const TEST_DB_DEFAULTS = {
  DB_HOST: 'localhost',
  DB_PORT: '6390',
  DB_PASSWORD: 'devpassword',
} as const;

export function applyEnvFile(contents: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(parse(contents))) {
    if (ENV_FILE_KEYS.has(key) && env[key] === undefined) env[key] = value;
  }
}

export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (existsSync(path)) applyEnvFile(readFileSync(path, 'utf8'), env);
}

export function applyTestDbOverrides(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(TEST_DB_DEFAULTS)) {
    const override = env[`TEST_${key}`];
    if (!env[key] && override) env[key] = override;
  }
}

export function applyConnectionSettings(
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = ROOT_ENV_FILE,
): void {
  applyTestDbOverrides(env);
  if (env.BETTERDB_TEST_USE_ENV_FILE === 'true') loadEnvFile(envFile, env);
  for (const [key, value] of Object.entries(TEST_DB_DEFAULTS)) {
    if (!env[key]) env[key] = value;
  }
}
