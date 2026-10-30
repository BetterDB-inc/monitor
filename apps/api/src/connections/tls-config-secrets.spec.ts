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

  it('never trusts secretsEncrypted from input', () => {
    const out = sanitizeTlsConfigInput({ cert: 'C', key: 'K', secretsEncrypted: true } as never);
    expect(out?.secretsEncrypted).toBe(false);
  });

  it('keeps only the fields that match the chosen source', () => {
    expect(sanitizeTlsConfigInput({ source: 'file', ca: 'C', caPath: ' ca.pem ', certPath: 'c.crt', keyPath: 'c.key' })).toEqual({
      source: 'file',
      caPath: 'ca.pem',
      certPath: 'c.crt',
      keyPath: 'c.key',
      secretsEncrypted: false,
    });
    expect(sanitizeTlsConfigInput({ ca: 'CA', caPath: 'ca.pem', passphrase: 'pw' })).toEqual({
      source: 'inline',
      ca: 'CA',
      passphrase: 'pw',
      secretsEncrypted: false,
    });
  });
});

describe('encryptTlsConfig / decryptTlsConfig', () => {
  const plain = { source: 'inline' as const, ca: 'CA', cert: 'CERT', key: 'KEY', passphrase: 'pw', secretsEncrypted: false };

  it('encrypts only the private key and passphrase', () => {
    const enc = encryptTlsConfig(plain, cipher);
    expect(enc).toEqual({ ...plain, key: 'enc(KEY)', passphrase: 'enc(pw)', secretsEncrypted: true });
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
