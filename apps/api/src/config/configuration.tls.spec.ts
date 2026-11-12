import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import configuration from './configuration';

const VARS = ['DB_TLS', 'DB_TLS_CA_FILE', 'DB_TLS_CERT_FILE', 'DB_TLS_KEY_FILE', 'DB_TLS_KEY_PASSPHRASE', 'DB_AUTH_MODE'];

describe('database TLS configuration from env', () => {
  const original: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    for (const v of VARS) {
      original[v] = process.env[v];
      delete process.env[v];
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-tls-env-'));
    fs.writeFileSync(path.join(dir, 'ca.pem'), 'CA');
    fs.writeFileSync(path.join(dir, 'client.crt'), 'CERT');
    fs.writeFileSync(path.join(dir, 'client.key'), 'KEY');
  });

  afterEach(() => {
    for (const v of VARS) {
      if (original[v] === undefined) delete process.env[v];
      else process.env[v] = original[v];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the PEM files as trusted file paths (re-read on reconnect) when DB_TLS is on', () => {
    process.env.DB_TLS = 'true';
    process.env.DB_TLS_CA_FILE = path.join(dir, 'ca.pem');
    process.env.DB_TLS_CERT_FILE = path.join(dir, 'client.crt');
    process.env.DB_TLS_KEY_FILE = path.join(dir, 'client.key');
    process.env.DB_TLS_KEY_PASSPHRASE = 'pw';
    process.env.DB_AUTH_MODE = 'Certificate';

    const { database } = configuration();
    expect(database.tlsConfig).toEqual({
      source: 'file',
      trustedPaths: true,
      caPath: path.join(dir, 'ca.pem'),
      certPath: path.join(dir, 'client.crt'),
      keyPath: path.join(dir, 'client.key'),
      passphrase: 'pw',
    });
    expect(database.authMode).toBe('certificate');
  });

  it('ignores DB_TLS_*_FILE paths, even unreadable ones, when DB_TLS is off', () => {
    process.env.DB_TLS_CA_FILE = path.join(dir, 'missing.pem');
    expect(() => configuration()).not.toThrow();
    expect(configuration().database.tlsConfig).toBeUndefined();
  });

  it('fails startup loudly for an unreadable file when DB_TLS is on', () => {
    process.env.DB_TLS = 'true';
    process.env.DB_TLS_CERT_FILE = path.join(dir, 'missing.crt');
    expect(() => configuration()).toThrow(/DB_TLS_CERT_FILE: cannot read/);
  });

  it('rejects an unknown DB_AUTH_MODE with the same validator as the env schema', () => {
    process.env.DB_AUTH_MODE = 'token';
    expect(() => configuration()).toThrow();
  });

  it('has no material when DB_TLS is on but no files are named', () => {
    process.env.DB_TLS = 'true';
    expect(configuration().database.tlsConfig).toBeUndefined();
  });
});
