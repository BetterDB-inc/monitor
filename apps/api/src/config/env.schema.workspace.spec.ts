import { envSchema } from './env.schema';

describe('workspace env vars', () => {
  it('defaults WORKSPACE_DISABLED to false and AUTH_BROKER_URL to betterdb.com', () => {
    const parsed = envSchema.parse({});
    expect(parsed.WORKSPACE_DISABLED).toBe(false);
    expect(parsed.AUTH_BROKER_URL).toBe('https://betterdb.com');
    expect(parsed.AUTH_SECRET).toBeUndefined();
    expect(parsed.AUTH_PUBLIC_URL).toBeUndefined();
  });

  it('reads WORKSPACE_DISABLED=true', () => {
    expect(envSchema.parse({ WORKSPACE_DISABLED: 'true' }).WORKSPACE_DISABLED).toBe(true);
  });

  it('rejects an AUTH_SECRET shorter than 32 characters', () => {
    expect(envSchema.safeParse({ AUTH_SECRET: 'short' }).success).toBe(false);
  });

  it('treats the empty auth URLs shipped in .env.example as unset', () => {
    const parsed = envSchema.parse({ AUTH_PUBLIC_URL: '', AUTH_BROKER_URL: '' });
    expect(parsed.AUTH_PUBLIC_URL).toBeUndefined();
    expect(parsed.AUTH_BROKER_URL).toBe('https://betterdb.com');
  });

  it('rejects a non-URL AUTH_PUBLIC_URL and strips a trailing slash', () => {
    expect(envSchema.safeParse({ AUTH_PUBLIC_URL: 'not a url' }).success).toBe(false);
    expect(envSchema.parse({ AUTH_PUBLIC_URL: 'https://mon.example.com/' }).AUTH_PUBLIC_URL).toBe(
      'https://mon.example.com',
    );
  });

  it('treats an empty POSTHOG_HOST as unset instead of failing URL validation', () => {
    // Regression: an empty POSTHOG_HOST injected around the container image
    // must not fail startup env validation.
    const parsed = envSchema.parse({ POSTHOG_HOST: '' });
    expect(parsed.POSTHOG_HOST).toBeUndefined();
    expect(envSchema.parse({ POSTHOG_HOST: 'https://ph.example.com' }).POSTHOG_HOST).toBe(
      'https://ph.example.com',
    );
    expect(envSchema.safeParse({ POSTHOG_HOST: 'not a url' }).success).toBe(false);
  });
});

describe('TLS boolean flags trim whitespace', () => {
  // Regression: these flags used `=== 'true'`, so a trailing newline from a
  // secret store (e.g. "true\n") silently meant off. They now go through
  // isTrueFlag, which trims.
  it('DB_TLS defaults to false and accepts whitespace-padded true', () => {
    expect(envSchema.parse({}).DB_TLS).toBe(false);
    expect(envSchema.parse({ DB_TLS: 'true' }).DB_TLS).toBe(true);
    expect(envSchema.parse({ DB_TLS: ' true\n' }).DB_TLS).toBe(true);
    expect(envSchema.parse({ DB_TLS: 'false' }).DB_TLS).toBe(false);
  });

  it('STORAGE_SSL_NO_VERIFY defaults to false and accepts whitespace-padded true', () => {
    expect(envSchema.parse({}).STORAGE_SSL_NO_VERIFY).toBe(false);
    expect(envSchema.parse({ STORAGE_SSL_NO_VERIFY: 'true' }).STORAGE_SSL_NO_VERIFY).toBe(true);
    expect(envSchema.parse({ STORAGE_SSL_NO_VERIFY: ' true\n' }).STORAGE_SSL_NO_VERIFY).toBe(true);
  });
});
