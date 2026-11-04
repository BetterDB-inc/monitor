import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseEnv } from 'util';

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

const TEST_DB_KEYS = ['DB_HOST', 'DB_PORT', 'DB_PASSWORD'] as const;

const SETUP_OWNED_KEYS = new Set<string>([...BLOCKED_KEYS, 'STORAGE_TYPE']);

function isConnectionSetting(key: string): boolean {
  return /^(DB|STORAGE)_/.test(key) && !SETUP_OWNED_KEYS.has(key);
}

export function applyEnvFile(contents: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (isConnectionSetting(key) && env[key] === undefined) env[key] = value;
  }
}

export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (existsSync(path)) applyEnvFile(readFileSync(path, 'utf8'), env);
}

export function applyTestDbOverrides(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of TEST_DB_KEYS) {
    const override = env[`TEST_${key}`];
    if (env[key] === undefined && override !== undefined) env[key] = override;
  }
}
