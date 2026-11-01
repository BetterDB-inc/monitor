import { decryptTlsConfig, encryptTlsConfig, sanitizeTlsConfigInput } from './tls-config-secrets';

const cipher = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => {
    const m = /^enc\((.*)\)$/s.exec(s);
    if (!m) throw new Error('not ciphertext');
    return m[1];
  },
};

describe('sanitizeTlsConfigInput', () => {
  it('returns undefined when nothing was supplied', () => {
    expect(sanitizeTlsConfigInput(undefined)).toBeUndefined();
    expect(sanitizeTlsConfigInput({})).toBeUndefined();
    expect(sanitizeTlsConfigInput({ ca: '   ', cert: '', passphrase: 'pw' })).toBeUndefined();
  });

  it('never trusts secretsEncrypted or trustedPaths from input', () => {
    const out = sanitizeTlsConfigInput({ source: 'file', certPath: '/etc/ssl/x', keyPath: '/etc/ssl/y', secretsEncrypted: true, trustedPaths: true } as never);
    expect(out?.secretsEncrypted).toBe(false);
    expect(out).not.toHaveProperty('trustedPaths');
  });

  it('keeps only the fields that match the chosen source', () => {
    expect(sanitizeTlsConfigInput({ source: 'file', ca: 'C', caPath: ' ca.pem ', certPath: 'c.crt', keyPath: 'c.key' })).toEqual({
      source: 'file',
      caPath: 'ca.pem',
      certPath: 'c.crt',
      keyPath: 'c.key',
      secretsEncrypted: false,
    });
    expect(sanitizeTlsConfigInput({ ca: 'CA', caPath: 'ca.pem', cert: 'C', key: 'K', passphrase: 'pw' })).toEqual({
      source: 'inline',
      ca: 'CA',
      cert: 'C',
      key: 'K',
      passphrase: 'pw',
      secretsEncrypted: false,
    });
  });

  it('drops a passphrase that has no private key to unlock', () => {
    expect(sanitizeTlsConfigInput({ ca: 'CA', passphrase: 'pw' })).toEqual({
      source: 'inline',
      ca: 'CA',
      secretsEncrypted: false,
    });
    expect(sanitizeTlsConfigInput({ source: 'file', caPath: 'ca.pem', keyPath: 'c.key', certPath: 'c.crt', passphrase: 'pw' })?.passphrase).toBe('pw');
  });
});

describe('encryptTlsConfig / decryptTlsConfig', () => {
  const plain = { source: 'inline' as const, ca: 'CA', cert: 'CERT', key: 'KEY', passphrase: 'pw', secretsEncrypted: false };

  it('encrypts only the private key and passphrase', () => {
    const enc = encryptTlsConfig(plain, cipher);
    expect(enc).toEqual({ ...plain, key: 'enc(KEY)', passphrase: 'enc(pw)', secretsEncrypted: true });
  });

  it('does not flag a config that holds no secrets (CA-only must not require ENCRYPTION_KEY later)', () => {
    const caOnly = { source: 'inline' as const, ca: 'CA', secretsEncrypted: false };
    const enc = encryptTlsConfig(caOnly, cipher);
    expect(enc).toBe(caOnly);
    expect(enc?.secretsEncrypted).toBe(false);
    const errors: string[] = [];
    expect(decryptTlsConfig(enc, null, (m) => errors.push(m))).toBe(caOnly);
    expect(errors).toEqual([]);
  });

  it('is a no-op without a cipher or when already encrypted', () => {
    expect(encryptTlsConfig(plain, null)).toBe(plain);
    const enc = encryptTlsConfig(plain, cipher);
    expect(encryptTlsConfig(enc, cipher)).toBe(enc);
  });

  it('round-trips through decrypt', () => {
    expect(decryptTlsConfig(encryptTlsConfig(plain, cipher), cipher)).toEqual(plain);
  });

  it('leaves plaintext configs alone', () => {
    expect(decryptTlsConfig(plain, cipher)).toBe(plain);
    expect(decryptTlsConfig(undefined, cipher)).toBeUndefined();
  });

  it('drops the secrets (never presents ciphertext as a key) when the cipher is missing', () => {
    const errors: string[] = [];
    const out = decryptTlsConfig(encryptTlsConfig(plain, cipher), null, (m) => errors.push(m));
    expect(out).toEqual({ ...plain, key: undefined, passphrase: undefined, secretsEncrypted: false });
    expect(errors[0]).toMatch(/ENCRYPTION_KEY/);
  });

  it('opens a CA-only record that was saved with an encrypted passphrase without needing the key', () => {
    const errors: string[] = [];
    const legacy = { source: 'inline' as const, ca: 'CA', passphrase: 'enc(pw)', secretsEncrypted: true };
    expect(decryptTlsConfig(legacy, null, (m) => errors.push(m))).toEqual({
      ...legacy,
      passphrase: undefined,
      key: undefined,
      secretsEncrypted: false,
    });
    expect(errors).toEqual([]);
  });

  it('drops the secrets when decryption fails', () => {
    const errors: string[] = [];
    const out = decryptTlsConfig(
      { ...plain, key: 'garbage', secretsEncrypted: true },
      cipher,
      (m) => errors.push(m),
    );
    expect(out?.key).toBeUndefined();
    expect(out?.secretsEncrypted).toBe(false);
    expect(errors[0]).toMatch(/Failed to decrypt/);
  });
});
