import { Logger } from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveAuthSecret } from './auth-secret';

type WriteFileSyncArgs = Parameters<typeof import('fs').writeFileSync>;

let mockWriteFileSyncOnce: ((...args: WriteFileSyncArgs) => void) | null = null;

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: (...args: WriteFileSyncArgs): void => {
      const override = mockWriteFileSyncOnce;
      if (override === null) {
        actual.writeFileSync(...args);
        return;
      }
      mockWriteFileSyncOnce = null;
      override(...args);
    },
  };
});

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
    mockWriteFileSyncOnce = null;
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

  it('forces 0600 on a reused secret stored with loose permissions', () => {
    const file = join(dataDir, 'auth-secret');
    const secret = 'z'.repeat(40);
    writeFileSync(file, secret, { mode: 0o644 });
    expect(resolveAuthSecret({}, dataDir)).toBe(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reuses the secret a racing process wrote instead of overwriting it', () => {
    const file = join(dataDir, 'auth-secret');
    const racedSecret = 'y'.repeat(43);
    mockWriteFileSyncOnce = () => {
      writeFileSync(file, racedSecret, { mode: 0o644 });
      const error = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      throw error;
    };

    expect(resolveAuthSecret({}, dataDir)).toBe(racedSecret);
    expect(readFileSync(file, 'utf8')).toBe(racedSecret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rethrows a write failure that is not a lost race', () => {
    mockWriteFileSyncOnce = () => {
      const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    };

    expect(() => {
      return resolveAuthSecret({}, dataDir);
    }).toThrow('EACCES');
  });
});
