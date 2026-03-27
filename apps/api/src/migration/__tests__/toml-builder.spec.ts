import { buildScanReaderToml } from '../execution/toml-builder';
import type { DatabaseConnectionConfig } from '@betterdb/shared';

function makeConfig(overrides: Partial<DatabaseConnectionConfig> = {}): DatabaseConnectionConfig {
  return {
    id: 'conn-1',
    name: 'Test',
    host: '127.0.0.1',
    port: 6379,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('buildScanReaderToml', () => {
  it('should generate valid TOML for single-node source and target', () => {
    const source = makeConfig({ host: '10.0.0.1', port: 6379, password: 'srcpass' });
    const target = makeConfig({ host: '10.0.0.2', port: 6380, password: 'tgtpass' });

    const toml = buildScanReaderToml(source, target, false);

    expect(toml).toContain('[scan_reader]');
    expect(toml).toContain('address = "10.0.0.1:6379"');
    expect(toml).toContain('password = "srcpass"');
    expect(toml).toContain('[redis_writer]');
    expect(toml).toContain('address = "10.0.0.2:6380"');
    expect(toml).toContain('password = "tgtpass"');
    expect(toml).not.toContain('cluster = true');
  });

  it('should include cluster = true for cluster source', () => {
    const source = makeConfig();
    const target = makeConfig();

    const toml = buildScanReaderToml(source, target, true);

    expect(toml).toContain('cluster = true');
  });

  it('should escape special characters in passwords', () => {
    const source = makeConfig({ password: 'pass"word\\with\nnewline' });
    const target = makeConfig({ password: 'simple' });

    const toml = buildScanReaderToml(source, target, false);

    expect(toml).toContain('pass\\"word\\\\with\\nnewline');
    expect(toml).not.toContain('pass"word');
  });

  it('should set tls = true when TLS enabled', () => {
    const source = makeConfig({ tls: true });
    const target = makeConfig({ tls: true });

    const toml = buildScanReaderToml(source, target, false);

    // Both sections should have tls = true
    const scanSection = toml.split('[redis_writer]')[0];
    const writerSection = toml.split('[redis_writer]')[1];
    expect(scanSection).toContain('tls = true');
    expect(writerSection).toContain('tls = true');
  });

  it('should set tls = false when TLS not enabled', () => {
    const source = makeConfig({ tls: false });
    const target = makeConfig({ tls: false });

    const toml = buildScanReaderToml(source, target, false);

    expect(toml).toContain('tls = false');
  });

  it('should use empty string for "default" username', () => {
    const source = makeConfig({ username: 'default' });
    const target = makeConfig({ username: 'default' });

    const toml = buildScanReaderToml(source, target, false);

    expect(toml).toContain('username = ""');
  });

  it('should include custom username when not "default"', () => {
    const source = makeConfig({ username: 'admin' });
    const target = makeConfig({ username: 'reader' });

    const toml = buildScanReaderToml(source, target, false);

    const scanSection = toml.split('[redis_writer]')[0];
    const writerSection = toml.split('[redis_writer]')[1];
    expect(scanSection).toContain('username = "admin"');
    expect(writerSection).toContain('username = "reader"');
  });

  it('should include [advanced] section with log_level', () => {
    const source = makeConfig();
    const target = makeConfig();

    const toml = buildScanReaderToml(source, target, false);

    expect(toml).toContain('[advanced]');
    expect(toml).toContain('log_level = "info"');
  });
});
