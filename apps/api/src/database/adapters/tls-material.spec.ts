import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TLS_CERT_DIR_ENV,
  assertAuthConfig,
  buildTlsOptions,
  clientCredentials,
  resolveTlsMaterial,
} from './tls-material';

const CA = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n';
const CERT = '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n';

describe('resolveTlsMaterial', () => {
  const originalDir = process.env[TLS_CERT_DIR_ENV];
  let certDir: string;

  beforeEach(() => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-material-'));
    fs.writeFileSync(path.join(certDir, 'ca.pem'), CA);
    fs.writeFileSync(path.join(certDir, 'client.crt'), CERT);
    fs.writeFileSync(path.join(certDir, 'client.key'), KEY);
    process.env[TLS_CERT_DIR_ENV] = certDir;
  });

  afterEach(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env[TLS_CERT_DIR_ENV];
    else process.env[TLS_CERT_DIR_ENV] = originalDir;
  });

  it('returns an empty object when nothing is configured', () => {
    expect(resolveTlsMaterial(undefined)).toEqual({});
    expect(resolveTlsMaterial({})).toEqual({});
  });

  it('passes inline PEM through unmodified', () => {
    expect(resolveTlsMaterial({ ca: CA, cert: CERT, key: KEY, passphrase: 'pw' })).toEqual({
      ca: CA,
      cert: CERT,
      key: KEY,
      passphrase: 'pw',
    });
  });

  it('ignores *Path fields when the source is inline', () => {
    expect(resolveTlsMaterial({ source: 'inline', caPath: 'ca.pem', cert: CERT, key: KEY })).toEqual({
      cert: CERT,
      key: KEY,
    });
  });

  it('reads file-sourced material from inside the allowlisted directory', () => {
    const out = resolveTlsMaterial({
      source: 'file',
      caPath: 'ca.pem',
      certPath: 'client.crt',
      keyPath: 'client.key',
      passphrase: 'pw',
    });
    expect(out.ca?.toString()).toBe(CA);
    expect(out.cert?.toString()).toBe(CERT);
    expect(out.key?.toString()).toBe(KEY);
    expect(out.passphrase).toBe('pw');
  });

  it('rejects file-sourced material when the allowlist directory is unset', () => {
    delete process.env[TLS_CERT_DIR_ENV];
    expect(() => resolveTlsMaterial({ source: 'file', caPath: 'ca.pem' })).toThrow(TLS_CERT_DIR_ENV);
  });

  it('rejects paths that escape the allowlisted directory without revealing the server path', () => {
    for (const caPath of ['../etc/passwd', '/etc/passwd']) {
      let message = '';
      try {
        resolveTlsMaterial({ source: 'file', caPath });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/must resolve inside BETTERDB_TLS_CERT_DIR/);
      expect(message).toContain(caPath);
      expect(message).not.toContain(certDir);
    }
  });

  it('explains a missing allowlist directory instead of throwing a raw ENOENT', () => {
    process.env[TLS_CERT_DIR_ENV] = path.join(certDir, 'does-not-exist');
    expect(() => resolveTlsMaterial({ source: 'file', caPath: 'ca.pem' })).toThrow(
      /BETTERDB_TLS_CERT_DIR directory does not exist/,
    );
  });

  it('reads operator-trusted absolute paths directly, bypassing the allowlist', () => {
    delete process.env[TLS_CERT_DIR_ENV];
    const out = resolveTlsMaterial({
      source: 'file',
      trustedPaths: true,
      caPath: path.join(certDir, 'ca.pem'),
      certPath: path.join(certDir, 'client.crt'),
      keyPath: path.join(certDir, 'client.key'),
    });
    expect(out.ca?.toString()).toBe(CA);
    expect(out.cert?.toString()).toBe(CERT);
    expect(out.key?.toString()).toBe(KEY);
    expect(() =>
      resolveTlsMaterial({ source: 'file', trustedPaths: true, caPath: path.join(certDir, 'nope.pem') }),
    ).toThrow(/Could not read CA bundle file/);
  });

  it('rejects a symlink that points outside the allowlisted directory', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.pem'), 'secret');
      fs.symlinkSync(path.join(outside, 'secret.pem'), path.join(certDir, 'link.pem'));
      expect(() => resolveTlsMaterial({ source: 'file', caPath: 'link.pem' })).toThrow(/symlink/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a missing file by its relative name only', () => {
    let message = '';
    try {
      resolveTlsMaterial({ source: 'file', certPath: 'missing.crt' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Client certificate file 'missing.crt' not found/);
    expect(message).not.toContain(certDir);
  });
});

describe('buildTlsOptions', () => {
  it('is undefined when TLS is off, even with material configured', () => {
    expect(buildTlsOptions({ tls: false, tlsConfig: { ca: CA } })).toBeUndefined();
  });

  it('is an empty object for plain TLS (Node defaults apply)', () => {
    expect(buildTlsOptions({ tls: true })).toEqual({});
  });

  it('carries the material when TLS is on', () => {
    expect(buildTlsOptions({ tls: true, tlsConfig: { cert: CERT, key: KEY } })).toEqual({
      cert: CERT,
      key: KEY,
    });
  });
});

describe('clientCredentials', () => {
  it('passes username/password through in password mode', () => {
    expect(clientCredentials({ username: 'app', password: 'pw' })).toEqual({
      username: 'app',
      password: 'pw',
    });
    expect(clientCredentials({ authMode: 'password', username: 'app', password: 'pw' })).toEqual({
      username: 'app',
      password: 'pw',
    });
  });

  it('normalises empty strings to undefined', () => {
    expect(clientCredentials({ username: '', password: '' })).toEqual({
      username: undefined,
      password: undefined,
    });
  });

  it('drops both in certificate mode so no AUTH is sent', () => {
    expect(clientCredentials({ authMode: 'certificate', username: 'default', password: 'pw' })).toEqual({
      username: undefined,
      password: undefined,
    });
  });
});

describe('assertAuthConfig', () => {
  it('accepts password mode without TLS material', () => {
    expect(() => assertAuthConfig({})).not.toThrow();
    expect(() => assertAuthConfig({ tls: true })).not.toThrow();
  });

  it('requires TLS for certificate mode', () => {
    expect(() =>
      assertAuthConfig({ authMode: 'certificate', tls: false, tlsConfig: { cert: CERT, key: KEY } }),
    ).toThrow(/requires TLS/);
  });

  it('requires a client certificate and key for certificate mode', () => {
    expect(() => assertAuthConfig({ authMode: 'certificate', tls: true })).toThrow(
      /client certificate and private key/,
    );
    expect(() =>
      assertAuthConfig({ authMode: 'certificate', tls: true, tlsConfig: { ca: CA } }),
    ).toThrow(/client certificate and private key/);
    expect(() =>
      assertAuthConfig({
        authMode: 'certificate',
        tls: true,
        tlsConfig: { source: 'file', certPath: 'c.crt', keyPath: 'c.key' },
      }),
    ).not.toThrow();
  });

  it('rejects a certificate without its key (and vice versa)', () => {
    expect(() => assertAuthConfig({ tls: true, tlsConfig: { cert: CERT } })).toThrow(/together/);
    expect(() => assertAuthConfig({ tls: true, tlsConfig: { key: KEY } })).toThrow(/together/);
    expect(() =>
      assertAuthConfig({ tls: true, tlsConfig: { source: 'file', certPath: 'c.crt' } }),
    ).toThrow(/together/);
  });
});
