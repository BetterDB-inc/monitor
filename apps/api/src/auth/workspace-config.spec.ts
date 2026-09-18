import { BROKER_SIGNING_PUBLIC_KEYS } from '@betterdb/shared';
import { resolveWorkspaceConfig } from './workspace-config';

describe('resolveWorkspaceConfig', () => {
  it('is enabled and self-hosted by default', () => {
    const config = resolveWorkspaceConfig({});
    expect(config.enabled).toBe(true);
    expect(config.mode).toBe('self-hosted');
    expect(config.basePath).toBe('/auth');
    expect(config.publicUrl).toBeNull();
    expect(config.brokerUrl).toBe('https://betterdb.com');
  });

  it('is disabled when WORKSPACE_DISABLED=true', () => {
    const config = resolveWorkspaceConfig({ WORKSPACE_DISABLED: 'true' });
    expect(config.enabled).toBe(false);
    expect(config.mode).toBe('disabled');
  });

  it('is cloud and disabled locally when CLOUD_MODE=true', () => {
    const config = resolveWorkspaceConfig({ CLOUD_MODE: 'true' });
    expect(config.enabled).toBe(false);
    expect(config.mode).toBe('cloud');
  });

  it('reads CLOUD_MODE the same way the module loader does', () => {
    expect(resolveWorkspaceConfig({ CLOUD_MODE: '1' }).mode).toBe('cloud');
    expect(resolveWorkspaceConfig({ CLOUD_MODE: 'TRUE' }).mode).toBe('cloud');
    expect(resolveWorkspaceConfig({ CLOUD_MODE: '0' }).mode).toBe('self-hosted');
  });

  it('treats CLOUD_MODE=false as self-hosted', () => {
    expect(resolveWorkspaceConfig({ CLOUD_MODE: 'false' }).mode).toBe('self-hosted');
  });

  it('uses the api prefix for the base path in production', () => {
    expect(resolveWorkspaceConfig({ NODE_ENV: 'production' }).basePath).toBe('/api/auth');
  });

  it('trusts the public url and the vite dev origin outside production', () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'https://mon.example.com/' });
    expect(config.publicUrl).toBe('https://mon.example.com');
    expect(config.trustedOrigins).toEqual(['https://mon.example.com', 'http://localhost:5173']);
    const prod = resolveWorkspaceConfig({
      NODE_ENV: 'production',
      AUTH_PUBLIC_URL: 'https://mon.example.com',
    });
    expect(prod.trustedOrigins).toEqual(['https://mon.example.com']);
  });

  it('treats empty auth urls as unset', () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: '', AUTH_BROKER_URL: '' });
    expect(config.publicUrl).toBeNull();
    expect(config.brokerUrl).toBe('https://betterdb.com');
    expect(config.trustedOrigins).toEqual(['http://localhost:5173']);
  });

  it('disables the broker when AUTH_BROKER_DISABLED=true', () => {
    const config = resolveWorkspaceConfig({
      AUTH_BROKER_DISABLED: 'true',
      AUTH_BROKER_PUBLIC_KEY: 'pem',
    });
    expect(config.brokerEnabled).toBe(false);
  });

  it('enables the broker with the embedded keys by default', () => {
    const config = resolveWorkspaceConfig({});
    expect(config.brokerKeys).toEqual(BROKER_SIGNING_PUBLIC_KEYS);
    expect(config.brokerEnabled).toBe(true);
  });

  it('enables the broker with a trusted key in self-hosted mode', () => {
    const config = resolveWorkspaceConfig({ AUTH_BROKER_PUBLIC_KEY: 'pem' });
    expect(config.brokerKeys).toEqual({ 'brk-override': 'pem' });
    expect(config.brokerEnabled).toBe(true);
  });

  it('disables the broker in production without a public url', () => {
    const config = resolveWorkspaceConfig({
      NODE_ENV: 'production',
      AUTH_BROKER_PUBLIC_KEY: 'pem',
    });
    expect(config.brokerEnabled).toBe(false);
  });

  it('enables the broker in production with a public url', () => {
    const config = resolveWorkspaceConfig({
      NODE_ENV: 'production',
      AUTH_BROKER_PUBLIC_KEY: 'pem',
      AUTH_PUBLIC_URL: 'https://monitor.example.com',
    });
    expect(config.brokerEnabled).toBe(true);
  });

  it('enables the broker outside production without a public url', () => {
    const config = resolveWorkspaceConfig({
      NODE_ENV: 'development',
      AUTH_BROKER_PUBLIC_KEY: 'pem',
    });
    expect(config.publicUrl).toBeNull();
    expect(config.brokerEnabled).toBe(true);
  });

  it('disables the broker in cloud mode even with a trusted key', () => {
    const config = resolveWorkspaceConfig({ CLOUD_MODE: 'true', AUTH_BROKER_PUBLIC_KEY: 'pem' });
    expect(config.brokerEnabled).toBe(false);
  });

  it('has no dev app origin in production', () => {
    const config = resolveWorkspaceConfig({ NODE_ENV: 'production' });
    expect(config.devAppOrigin).toBeNull();
  });
});
