import { Logger } from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveAuthSecret } from './auth-secret';

describe('resolveAuthSecret', () => {
  let dataDir: string;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'auth-secret-'));
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      return undefined;
    });
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    logSpy.mockRestore();
    warnSpy.mockRestore();
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

  it('rejects an empty data dir instead of writing to the process root', () => {
    expect(() => {
      return resolveAuthSecret({}, '');
    }).toThrow('BETTERDB_DATA_DIR must not be empty');
  });

  it('logs the path of a freshly generated secret', () => {
    resolveAuthSecret({}, dataDir);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Generated a new auth secret at ${join(dataDir, 'auth-secret')}`),
    );
  });

  it('warns that sessions are invalidated when a stored secret is too short', () => {
    writeFileSync(join(dataDir, 'auth-secret'), 'short');
    resolveAuthSecret({}, dataDir);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalidates all sessions'));
  });
});
