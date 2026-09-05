import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const SECRET_FILE = 'auth-secret';
const MIN_SECRET_LENGTH = 32;

const logger = new Logger('WorkspaceAuth');

function generateSecret(): string {
  return randomBytes(MIN_SECRET_LENGTH).toString('base64url');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function restrictPermissions(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch (error) {
    logger.warn(`Could not restrict the permissions of ${file}: ${describeError(error)}`);
  }
}

function readStoredSecret(file: string): string | null {
  let stored: string;
  try {
    stored = readFileSync(file, 'utf8').trim();
  } catch (error) {
    logger.warn(`Could not read the auth secret stored at ${file}: ${describeError(error)}`);
    return null;
  }
  if (stored.length < MIN_SECRET_LENGTH) {
    return null;
  }
  restrictPermissions(file);
  return stored;
}

function ephemeralSecret(file: string, error: unknown): string {
  logger.warn(
    `Could not persist an auth secret at ${file}: ${describeError(error)}. Continuing with an ` +
      'in-memory secret: sessions are invalidated on every restart and are not shared between ' +
      'processes. Set AUTH_SECRET to a value of at least 32 characters to keep sessions stable.',
  );
  return generateSecret();
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
      `The auth secret stored at ${file} could not be read or is shorter than ` +
        `${MIN_SECRET_LENGTH} characters; replacing it invalidates all sessions`,
    );
    try {
      rmSync(file, { force: true });
    } catch (error) {
      return ephemeralSecret(file, error);
    }
  }
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    return ephemeralSecret(file, error);
  }
  const generated = generateSecret();
  try {
    writeFileSync(file, generated, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = readStoredSecret(file);
      if (raced !== null) {
        logger.log(`Reusing the auth secret another process wrote at ${file}`);
        return raced;
      }
    }
    return ephemeralSecret(file, error);
  }
  restrictPermissions(file);
  logger.log(`Generated a new auth secret at ${file}`);
  return generated;
}
