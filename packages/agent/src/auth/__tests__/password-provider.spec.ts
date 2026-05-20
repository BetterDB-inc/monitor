import { PasswordProvider } from '../password-provider';

describe('PasswordProvider', () => {
  it('returns the configured password from getToken()', async () => {
    const provider = new PasswordProvider('s3cr3t');
    expect(await provider.getToken()).toBe('s3cr3t');
  });

  it('returns the same value on every call', async () => {
    const provider = new PasswordProvider('abc');
    expect(await provider.getToken()).toBe(await provider.getToken());
  });

  it('has mode="password" and requiresFreshTokenPerConnection=false', () => {
    const provider = new PasswordProvider('x');
    expect(provider.mode).toBe('password');
    expect(provider.requiresFreshTokenPerConnection).toBe(false);
  });
});
