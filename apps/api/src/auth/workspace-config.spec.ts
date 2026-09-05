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
});
