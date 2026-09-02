import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SECRET_FILE = 'auth-secret';
const MIN_SECRET_LENGTH = 32;

const logger = new Logger('WorkspaceAuth');

export function resolveAuthSecret(env: NodeJS.ProcessEnv, dataDir: string): string {
  if (env.AUTH_SECRET !== undefined && env.AUTH_SECRET.length >= MIN_SECRET_LENGTH) {
    return env.AUTH_SECRET;
  }
  if (dataDir.trim() === '') {
    throw new Error('BETTERDB_DATA_DIR must not be empty');
  }
  const file = join(dataDir, SECRET_FILE);
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= MIN_SECRET_LENGTH) {
      return stored;
    }
    logger.warn(
      `The auth secret stored at ${file} is shorter than ${MIN_SECRET_LENGTH} characters; replacing it invalidates all sessions`,
    );
  }
  mkdirSync(dataDir, { recursive: true });
  const generated = randomBytes(MIN_SECRET_LENGTH).toString('base64url');
  writeFileSync(file, generated, { mode: 0o600 });
  chmodSync(file, 0o600);
  logger.log(`Generated a new auth secret at ${file}`);
  return generated;
}
