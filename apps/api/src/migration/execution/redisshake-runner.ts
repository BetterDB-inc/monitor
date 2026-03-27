import { existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';

export function findRedisShakeBinary(): string {
  // 1. Explicit env override
  if (process.env.REDIS_SHAKE_PATH && existsSync(process.env.REDIS_SHAKE_PATH)) {
    return process.env.REDIS_SHAKE_PATH;
  }
  // 2. Docker image location
  if (existsSync('/usr/local/bin/redis-shake')) {
    return '/usr/local/bin/redis-shake';
  }
  // 3. npx install location
  const npxPath = join(os.homedir(), '.betterdb', 'bin', 'redis-shake');
  if (npxPath && existsSync(npxPath)) {
    return npxPath;
  }
  throw new Error(
    'RedisShake binary not found. ' +
    'Set REDIS_SHAKE_PATH env var, or install it to ~/.betterdb/bin/redis-shake. ' +
    'See https://docs.betterdb.com/migration for instructions.',
  );
}
