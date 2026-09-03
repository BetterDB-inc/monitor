import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const SECRET_FILE = 'auth-secret';
const MIN_SECRET_LENGTH = 32;

const logger = new Logger('WorkspaceAuth');

function readStoredSecret(file: string): string | null {
  const stored = readFileSync(file, 'utf8').trim();
  if (stored.length < MIN_SECRET_LENGTH) {
    return null;
  }
  chmodSync(file, 0o600);
  return stored;
}

export function resolveAuthSecret(env: NodeJS.ProcessEnv, dataDir: string): string {
  if (env.AUTH_SECRET !== undefined && env.AUTH_SECRET.length >= MIN_SECRET_LENGTH) {
    return env.AUTH_SECRET;
  }
  if (dataDir.trim() === '') {
    throw new Error('BETTERDB_DATA_DIR must not be empty');
  }
  const file = join(dataDir, SECRET_FILE);
  if (existsSync(file)) {
    const stored = readStoredSecret(file);
    if (stored !== null) {
      return stored;
    }
    logger.warn(
      `The auth secret stored at ${file} is shorter than ${MIN_SECRET_LENGTH} characters; replacing it invalidates all sessions`,
    );
    rmSync(file, { force: true });
  }
  mkdirSync(dataDir, { recursive: true });
  const generated = randomBytes(MIN_SECRET_LENGTH).toString('base64url');
  try {
    writeFileSync(file, generated, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const raced = readStoredSecret(file);
    if (raced === null) {
      throw error;
    }
    logger.log(`Reusing the auth secret another process wrote at ${file}`);
    return raced;
  }
  chmodSync(file, 0o600);
  logger.log(`Generated a new auth secret at ${file}`);
  return generated;
}
