import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionOptions } from 'tls';
import type { DatabaseAuthMode, TlsConfig } from '@betterdb/shared';
import { hasClientCertificate } from '@betterdb/shared';

/**
 * Directory that server-side TLS files (CA bundle, client certificate, private
 * key) must live in when a connection uses `tlsConfig.source === 'file'`. Unset
 * disables file-based material; inline PEM still works. Mirrors
 * BETTERDB_SSH_KEY_DIR for SSH private keys.
 */
export const TLS_CERT_DIR_ENV = 'BETTERDB_TLS_CERT_DIR';

/** The subset of Node TLS options this module produces. */
export type TlsMaterialOptions = Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'passphrase'>;

/**
 * Validate the auth/TLS combination before any socket is opened, so a
 * misconfigured connection fails with a clear message instead of a handshake or
 * NOAUTH error. Throws on an invalid combination.
 */
export function assertAuthConfig(config: {
  tls?: boolean;
  tlsConfig?: TlsConfig;
  authMode?: DatabaseAuthMode;
}): void {
  const mode = config.authMode ?? 'password';
  if (mode === 'certificate') {
    if (!config.tls) {
      throw new Error('Certificate authentication requires TLS to be enabled');
    }
    if (!hasClientCertificate(config.tlsConfig)) {
      throw new Error('Certificate authentication requires a client certificate and private key');
    }
  }
  const tlsConfig = config.tlsConfig;
  if (!tlsConfig) return;
  const source = tlsConfig.source ?? 'inline';
  const hasCert = source === 'file' ? !!tlsConfig.certPath : !!tlsConfig.cert;
  const hasKey = source === 'file' ? !!tlsConfig.keyPath : !!tlsConfig.key;
  if (hasCert !== hasKey) {
    throw new Error('A client certificate and its private key must be supplied together');
  }
}

/**
 * Read a file for TLS material, enforcing the BETTERDB_TLS_CERT_DIR allowlist:
 * the path is resolved against that directory and must stay inside it, both
 * lexically and after following symlinks. Same policy as SSH key files.
 */
function readAllowlistedFile(filePath: string, label: string): Buffer {
  const certDir = process.env[TLS_CERT_DIR_ENV];
  if (!certDir || certDir.trim() === '') {
    throw new Error(
      `Server-side TLS files are disabled. Set the ${TLS_CERT_DIR_ENV} environment ` +
        'variable to a directory containing allowed certificate files to enable this option.',
    );
  }
  const baseDir = fs.realpathSync(path.resolve(certDir));
  const resolved = path.resolve(baseDir, filePath);
  const contains = (candidate: string): boolean => {
    const rel = path.relative(baseDir, candidate);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (!contains(resolved)) {
    throw new Error(`${label} path must resolve inside ${TLS_CERT_DIR_ENV} (${baseDir})`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} file not found: ${resolved}`);
  }
  const realResolved = fs.realpathSync(resolved);
  if (!contains(realResolved)) {
    throw new Error(`${label} path escapes ${TLS_CERT_DIR_ENV} via a symlink (${baseDir})`);
  }
  try {
    return fs.readFileSync(realResolved);
  } catch {
    throw new Error(`Could not read ${label} file: ${resolved}`);
  }
}

/**
 * Resolve a connection's TLS material (decrypted) into the Node `tls.connect`
 * options that drive server verification against a custom CA and client
 * certificate presentation. Returns an empty object when nothing is configured,
 * so Node's defaults (system CA store, no client certificate) apply. Material is
 * passed through unmodified: the certificate's subject (CN) is whatever the
 * user supplied.
 */
export function resolveTlsMaterial(tlsConfig: TlsConfig | undefined): TlsMaterialOptions {
  if (!tlsConfig) return {};
  const source = tlsConfig.source ?? 'inline';
  const out: TlsMaterialOptions = {};
  if (source === 'file') {
    if (tlsConfig.caPath) out.ca = readAllowlistedFile(tlsConfig.caPath, 'CA bundle');
    if (tlsConfig.certPath) out.cert = readAllowlistedFile(tlsConfig.certPath, 'Client certificate');
    if (tlsConfig.keyPath) out.key = readAllowlistedFile(tlsConfig.keyPath, 'Client private key');
  } else {
    if (tlsConfig.ca) out.ca = tlsConfig.ca;
    if (tlsConfig.cert) out.cert = tlsConfig.cert;
    if (tlsConfig.key) out.key = tlsConfig.key;
  }
  if (tlsConfig.passphrase) out.passphrase = tlsConfig.passphrase;
  return out;
}

/**
 * Build the `tls` option for an iovalkey client from a connection config:
 * `undefined` when TLS is off, otherwise the resolved material (possibly empty,
 * meaning plain server-verified TLS). Callers that need SNI add
 * `tlsIdentityOptions` on top.
 */
export function buildTlsOptions(config: {
  tls?: boolean;
  tlsConfig?: TlsConfig;
}): ConnectionOptions | undefined {
  if (!config.tls) return undefined;
  return resolveTlsMaterial(config.tlsConfig);
}

/**
 * Credentials to hand to iovalkey. In `certificate` mode both are omitted so the
 * client sends no AUTH at all (iovalkey only issues AUTH when a username or
 * password is set) and the server keeps the ACL user it derived from the client
 * certificate. In `password` mode the values pass through unchanged.
 */
export function clientCredentials(config: {
  authMode?: DatabaseAuthMode;
  username?: string;
  password?: string;
}): { username: string | undefined; password: string | undefined } {
  if ((config.authMode ?? 'password') === 'certificate') {
    return { username: undefined, password: undefined };
  }
  return { username: config.username || undefined, password: config.password || undefined };
}
