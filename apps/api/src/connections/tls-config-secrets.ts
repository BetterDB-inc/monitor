import type { TlsConfig, TlsConfigInput } from '@betterdb/shared';

/** Minimal encryption surface used for TLS secrets (matches EnvelopeEncryptionService). */
export interface TlsSecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * Strip server-managed fields from a caller-supplied TLS config and normalise
 * blanks. `secretsEncrypted` must never be trusted from input, or a client could
 * submit a plaintext private key flagged as already-encrypted and bypass
 * encryption at rest. Returns undefined when nothing meaningful was supplied so
 * a connection without material stores no `tlsConfig` at all.
 */
export function sanitizeTlsConfigInput(input: TlsConfigInput | undefined): TlsConfig | undefined {
  if (!input) return undefined;
  // `trustedPaths` would let a caller read arbitrary server files by absolute
  // path; like `secretsEncrypted` it is server-managed and never taken from input.
  const { secretsEncrypted: _ignored, trustedPaths: _alsoIgnored, ...rest } = input as TlsConfig;
  const trim = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const source = rest.source === 'file' ? 'file' : 'inline';
  const out: TlsConfig = {
    source,
    ca: source === 'inline' ? trim(rest.ca) : undefined,
    cert: source === 'inline' ? trim(rest.cert) : undefined,
    key: source === 'inline' ? trim(rest.key) : undefined,
    caPath: source === 'file' ? trim(rest.caPath) : undefined,
    certPath: source === 'file' ? trim(rest.certPath) : undefined,
    keyPath: source === 'file' ? trim(rest.keyPath) : undefined,
    passphrase: rest.passphrase ? rest.passphrase : undefined,
    secretsEncrypted: false,
  };
  const hasMaterial = !!(out.ca || out.cert || out.key || out.caPath || out.certPath || out.keyPath);
  if (!hasMaterial) return undefined;
  for (const field of Object.keys(out) as (keyof TlsConfig)[]) {
    if (out[field] === undefined) delete out[field];
  }
  return out;
}

/**
 * Encrypt the secret fields of a TLS config for storage. The CA bundle and
 * client certificate are public material and file paths are not secrets; only
 * the private key and its passphrase are encrypted.
 */
export function encryptTlsConfig(
  config: TlsConfig | undefined,
  cipher: TlsSecretCipher | null | undefined,
): TlsConfig | undefined {
  if (!config || !cipher || config.secretsEncrypted) {
    return config;
  }
  // Only flag the record as encrypted when something actually was: a CA-only
  // config must not demand ENCRYPTION_KEY on a later boot.
  if (!config.key && !config.passphrase) {
    return config;
  }
  return {
    ...config,
    key: config.key ? cipher.encrypt(config.key) : config.key,
    passphrase: config.passphrase ? cipher.encrypt(config.passphrase) : config.passphrase,
    secretsEncrypted: true,
  };
}

/**
 * Decrypt the secret fields of a persisted TLS config for use. When the key is
 * unavailable or decryption fails the secrets are dropped (so a connection
 * cannot accidentally present ciphertext as a private key) and `onError` is
 * told why.
 */
export function decryptTlsConfig(
  config: TlsConfig | undefined,
  cipher: TlsSecretCipher | null | undefined,
  onError: (message: string) => void = () => undefined,
): TlsConfig | undefined {
  if (!config || !config.secretsEncrypted) {
    return config;
  }
  const dropped: TlsConfig = { ...config, key: undefined, passphrase: undefined, secretsEncrypted: false };
  if (!cipher) {
    onError('ENCRYPTION_KEY not set but TLS client key is encrypted; client certificate unavailable');
    return dropped;
  }
  try {
    return {
      ...config,
      key: config.key ? cipher.decrypt(config.key) : config.key,
      passphrase: config.passphrase ? cipher.decrypt(config.passphrase) : config.passphrase,
      secretsEncrypted: false,
    };
  } catch (error) {
    onError(`Failed to decrypt TLS client key: ${error instanceof Error ? error.message : error}`);
    return dropped;
  }
}
