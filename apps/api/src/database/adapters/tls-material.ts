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
  // Error messages name only the user-supplied path and the env var: the
  // resolved server path is returned verbatim by the test endpoint and must not
  // disclose the filesystem layout.
  let baseDir: string;
  try {
    baseDir = fs.realpathSync(path.resolve(certDir));
  } catch {
    throw new Error(`The ${TLS_CERT_DIR_ENV} directory does not exist on the server`);
  }
  const resolved = path.resolve(baseDir, filePath);
  const contains = (candidate: string): boolean => {
    const rel = path.relative(baseDir, candidate);
    // Reject only a leading `..` path segment: a file literally named
    // `..client.pem` inside the directory is fine.
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (!contains(resolved)) {
    throw new Error(`${label} path '${filePath}' must resolve inside ${TLS_CERT_DIR_ENV}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} file '${filePath}' not found in ${TLS_CERT_DIR_ENV}`);
  }
  let realResolved: string;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    // A raw ENOENT/EACCES would carry the absolute server path.
    throw new Error(`Could not read ${label} file '${filePath}' in ${TLS_CERT_DIR_ENV}`);
  }
  if (!contains(realResolved)) {
    throw new Error(`${label} path '${filePath}' escapes ${TLS_CERT_DIR_ENV} via a symlink`);
  }
  try {
    return fs.readFileSync(realResolved);
  } catch {
    throw new Error(`Could not read ${label} file '${filePath}' in ${TLS_CERT_DIR_ENV}`);
  }
}

/**
 * Operator-owned absolute paths (DB_TLS_*_FILE). The operator controls the
 * environment, so there is no allowlist to enforce; the message may name the
 * path because it came from that same operator's configuration.
 */
function readTrustedFile(filePath: string, label: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`Could not read ${label} file ${filePath}: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    });
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
    const read = tlsConfig.trustedPaths ? readTrustedFile : readAllowlistedFile;
    if (tlsConfig.caPath) out.ca = read(tlsConfig.caPath, 'CA bundle');
    if (tlsConfig.certPath) out.cert = read(tlsConfig.certPath, 'Client certificate');
    if (tlsConfig.keyPath) out.key = read(tlsConfig.keyPath, 'Client private key');
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
