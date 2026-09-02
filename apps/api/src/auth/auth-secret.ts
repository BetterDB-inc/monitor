import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SECRET_FILE = 'auth-secret';

export function resolveAuthSecret(env: NodeJS.ProcessEnv, dataDir: string): string {
  if (env.AUTH_SECRET !== undefined && env.AUTH_SECRET.length >= 32) {
    return env.AUTH_SECRET;
  }
  const file = join(dataDir, SECRET_FILE);
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= 32) {
      return stored;
    }
  }
  mkdirSync(dataDir, { recursive: true });
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(file, generated, { mode: 0o600 });
  chmodSync(file, 0o600);
  return generated;
}
