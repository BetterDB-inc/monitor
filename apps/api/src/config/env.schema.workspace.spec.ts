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

  it('rejects a non-URL AUTH_PUBLIC_URL and strips a trailing slash', () => {
    expect(envSchema.safeParse({ AUTH_PUBLIC_URL: 'not a url' }).success).toBe(false);
    expect(envSchema.parse({ AUTH_PUBLIC_URL: 'https://mon.example.com/' }).AUTH_PUBLIC_URL).toBe(
      'https://mon.example.com',
    );
  });
});
