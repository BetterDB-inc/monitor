import { Logger } from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveAuthSecret } from './auth-secret';

type FsModule = typeof import('fs');
type WriteFileSyncArgs = Parameters<FsModule['writeFileSync']>;
type MkdirSyncArgs = Parameters<FsModule['mkdirSync']>;
type ChmodSyncArgs = Parameters<FsModule['chmodSync']>;
type ReadFileSyncArgs = Parameters<FsModule['readFileSync']>;

const overrides: {
  writeFileSync: ((...args: WriteFileSyncArgs) => void) | null;
  mkdirSync: ((...args: MkdirSyncArgs) => void) | null;
  chmodSync: ((...args: ChmodSyncArgs) => void) | null;
  readFileSync: ((...args: ReadFileSyncArgs) => string) | null;
} = { writeFileSync: null, mkdirSync: null, chmodSync: null, readFileSync: null };

jest.mock('fs', () => {
  const actual = jest.requireActual<FsModule>('fs');
  return {
    ...actual,
    writeFileSync: (...args: WriteFileSyncArgs): void => {
      const override = overrides.writeFileSync;
      if (override === null) {
        actual.writeFileSync(...args);
        return;
      }
      overrides.writeFileSync = null;
      override(...args);
    },
    mkdirSync: (...args: MkdirSyncArgs): void => {
      const override = overrides.mkdirSync;
      if (override === null) {
        actual.mkdirSync(...args);
        return;
      }
      overrides.mkdirSync = null;
      override(...args);
    },
    chmodSync: (...args: ChmodSyncArgs): void => {
      const override = overrides.chmodSync;
      if (override === null) {
        actual.chmodSync(...args);
        return;
      }
      overrides.chmodSync = null;
      override(...args);
    },
    readFileSync: (...args: ReadFileSyncArgs): string => {
      const override = overrides.readFileSync;
      if (override === null) {
        return actual.readFileSync(...args) as string;
      }
      overrides.readFileSync = null;
      return override(...args);
    },
  };
});

function failWith(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

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
    overrides.writeFileSync = null;
    overrides.mkdirSync = null;
    overrides.chmodSync = null;
    overrides.readFileSync = null;
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
    overrides.writeFileSync = () => {
      writeFileSync(file, racedSecret, { mode: 0o644 });
      throw failWith('EEXIST', 'file already exists');
    };

    expect(resolveAuthSecret({}, dataDir)).toBe(racedSecret);
    expect(readFileSync(file, 'utf8')).toBe(racedSecret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps booting with an in-memory secret when the file cannot be written', () => {
    overrides.writeFileSync = () => {
      throw failWith('EROFS', 'read-only file system');
    };

    expect(resolveAuthSecret({}, dataDir)).toHaveLength(43);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('in-memory secret'));
  });

  it('keeps booting with an in-memory secret when the data directory cannot be created', () => {
    overrides.mkdirSync = () => {
      throw failWith('EACCES', 'permission denied');
    };

    expect(resolveAuthSecret({}, join(dataDir, 'nested'))).toHaveLength(43);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('in-memory secret'));
  });

  it('reuses a pre-seeded secret whose permissions cannot be tightened', () => {
    const file = join(dataDir, 'auth-secret');
    const secret = 'q'.repeat(40);
    writeFileSync(file, secret, { mode: 0o644 });
    overrides.chmodSync = () => {
      throw failWith('EPERM', 'operation not permitted');
    };

    expect(resolveAuthSecret({}, dataDir)).toBe(secret);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not restrict the permissions'),
    );
  });

  it('keeps booting with an in-memory secret when a stored file cannot be read', () => {
    const file = join(dataDir, 'auth-secret');
    writeFileSync(file, 'w'.repeat(40), { mode: 0o600 });
    overrides.readFileSync = () => {
      throw failWith('EACCES', 'permission denied');
    };

    expect(resolveAuthSecret({}, dataDir)).toHaveLength(43);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not read the auth secret stored at'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('in-memory secret'));
  });

  it('leaves an unreadable secret on disk so a later boot can recover it', () => {
    const file = join(dataDir, 'auth-secret');
    const secret = 'w'.repeat(40);
    writeFileSync(file, secret, { mode: 0o600 });
    overrides.readFileSync = () => {
      throw failWith('EACCES', 'permission denied');
    };

    expect(resolveAuthSecret({}, dataDir)).not.toBe(secret);
    expect(readFileSync(file, 'utf8')).toBe(secret);
    expect(resolveAuthSecret({}, dataDir)).toBe(secret);
  });
});
