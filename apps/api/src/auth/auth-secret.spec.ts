import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveAuthSecret } from './auth-secret';

describe('resolveAuthSecret', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'auth-secret-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('prefers AUTH_SECRET from the environment', () => {
    const secret = 'x'.repeat(40);
    expect(resolveAuthSecret({ AUTH_SECRET: secret }, dataDir)).toBe(secret);
  });

  it('generates, persists with 0600 and reuses a secret when the env is unset', () => {
    const first = resolveAuthSecret({}, dataDir);
    expect(first.length).toBeGreaterThanOrEqual(43);
    const file = join(dataDir, 'auth-secret');
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveAuthSecret({}, dataDir)).toBe(first);
  });

  it('creates the data directory when missing', () => {
    const nested = join(dataDir, 'nested', 'dir');
    expect(resolveAuthSecret({}, nested)).toHaveLength(43);
  });

  it('enforces 0600 when overwriting a pre-existing file with loose permissions', () => {
    const file = join(dataDir, 'auth-secret');
    const shortSecret = 'short';
    writeFileSync(file, shortSecret, { mode: 0o644 });
    const result = resolveAuthSecret({}, dataDir);
    expect(result).toHaveLength(43);
    expect(readFileSync(file, 'utf8')).toBe(result);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
