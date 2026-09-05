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

type StoredSecret =
  | { kind: 'usable'; secret: string }
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'tooShort' };

function readStoredSecret(file: string): StoredSecret {
  let stored: string;
  try {
    stored = readFileSync(file, 'utf8').trim();
  } catch (error) {
    return { kind: 'unreadable', error };
  }
  if (stored.length < MIN_SECRET_LENGTH) {
    return { kind: 'tooShort' };
  }
  restrictPermissions(file);
  return { kind: 'usable', secret: stored };
}

const EPHEMERAL_NOTE =
  'Continuing with an in-memory secret: sessions are invalidated on every restart and are not ' +
  'shared between processes. Set AUTH_SECRET to a value of at least 32 characters to keep ' +
  'sessions stable.';

function ephemeralSecret(reason: string): string {
  logger.warn(`${reason} ${EPHEMERAL_NOTE}`);
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
    if (stored.kind === 'usable') {
      return stored.secret;
    }
    if (stored.kind === 'unreadable') {
      return ephemeralSecret(
        `Could not read the auth secret stored at ${file}: ${describeError(stored.error)}. ` +
          'Leaving the file in place so a later boot can still use it.',
      );
    }
    logger.warn(
      `The auth secret stored at ${file} is shorter than ${MIN_SECRET_LENGTH} characters; ` +
        'replacing it invalidates all sessions',
    );
    try {
      rmSync(file, { force: true });
    } catch (error) {
      return ephemeralSecret(
        `Could not replace the auth secret at ${file}: ${describeError(error)}.`,
      );
    }
  }
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    return ephemeralSecret(`Could not persist an auth secret at ${file}: ${describeError(error)}.`);
  }
  const generated = generateSecret();
  try {
    writeFileSync(file, generated, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = readStoredSecret(file);
      if (raced.kind === 'usable') {
        logger.log(`Reusing the auth secret another process wrote at ${file}`);
        return raced.secret;
      }
    }
    return ephemeralSecret(`Could not persist an auth secret at ${file}: ${describeError(error)}.`);
  }
  restrictPermissions(file);
  logger.log(`Generated a new auth secret at ${file}`);
  return generated;
}
