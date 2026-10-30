import { envSchema } from './env.schema';

describe('database TLS env vars', () => {
  it('leaves the TLS material and auth mode unset by default', () => {
    const parsed = envSchema.parse({});
    expect(parsed.DB_TLS_CA_FILE).toBeUndefined();
    expect(parsed.DB_TLS_CERT_FILE).toBeUndefined();
    expect(parsed.DB_TLS_KEY_FILE).toBeUndefined();
    expect(parsed.DB_TLS_KEY_PASSPHRASE).toBeUndefined();
    expect(parsed.DB_AUTH_MODE).toBeUndefined();
    expect(parsed.BETTERDB_TLS_CERT_DIR).toBeUndefined();
  });

  it('normalises DB_AUTH_MODE case and whitespace before validating', () => {
    expect(envSchema.parse({ DB_AUTH_MODE: 'Certificate' }).DB_AUTH_MODE).toBe('certificate');
    expect(envSchema.parse({ DB_AUTH_MODE: ' password\n' }).DB_AUTH_MODE).toBe('password');
    expect(envSchema.parse({ DB_AUTH_MODE: '' }).DB_AUTH_MODE).toBeUndefined();
  });

  it('rejects an unknown DB_AUTH_MODE', () => {
    expect(envSchema.safeParse({ DB_AUTH_MODE: 'token' }).success).toBe(false);
  });
});
