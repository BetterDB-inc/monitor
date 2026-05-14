import { buildScanReaderToml, buildSyncReaderToml } from '../execution/toml-builder';
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

  it('should emit cluster = false in writer when target is standalone (default)', () => {
    const toml = buildScanReaderToml(makeConfig(), makeConfig(), false);
    const writerSection = toml.split('[redis_writer]')[1];
    expect(writerSection).toContain('cluster = false');
  });

  it('should emit cluster = true in writer when target is a cluster', () => {
    const toml = buildScanReaderToml(makeConfig(), makeConfig(), false, true);
    const writerSection = toml.split('[redis_writer]')[1];
    expect(writerSection).toContain('cluster = true');
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

  it('should reject control characters in password instead of silently stripping', () => {
    const source = makeConfig({ password: 'pass\x00word' });
    const target = makeConfig();

    expect(() => buildScanReaderToml(source, target, false)).toThrow('control characters');
  });

  it('should reject invalid port', () => {
    const source = makeConfig({ port: 99999 as any });
    const target = makeConfig();

    expect(() => buildScanReaderToml(source, target, false)).toThrow('Invalid port');
  });

  it('should reject host with whitespace', () => {
    const source = makeConfig({ host: 'host name' });
    const target = makeConfig();

    expect(() => buildScanReaderToml(source, target, false)).toThrow('Invalid host');
  });

  it('should reject empty host', () => {
    const source = makeConfig({ host: '' });
    const target = makeConfig();

    expect(() => buildScanReaderToml(source, target, false)).toThrow('Invalid host');
  });

  it('should wrap bare IPv6 addresses in brackets for Go net.Dial', () => {
    const source = makeConfig({ host: '::1', port: 6379 });
    const target = makeConfig({ host: '2001:db8::1', port: 6380 });

    const toml = buildScanReaderToml(source, target, false);

    expect(toml).toContain('address = "[::1]:6379"');
    expect(toml).toContain('address = "[2001:db8::1]:6380"');
  });

  it('should not double-bracket already-bracketed IPv6 addresses', () => {
    const source = makeConfig({ host: '[::1]', port: 6379 });
    const target = makeConfig();

    const toml = buildScanReaderToml(source, target, false);

    expect(toml).toContain('address = "[::1]:6379"');
    expect(toml).not.toContain('[[');
  });

  it('should not bracket IPv4 addresses containing no colons', () => {
    const source = makeConfig({ host: '127.0.0.1', port: 6379 });
    const target = makeConfig();

    const toml = buildScanReaderToml(source, target, false);

    expect(toml).toContain('address = "127.0.0.1:6379"');
  });
});

describe('buildSyncReaderToml', () => {
  it('should generate valid TOML for single-node source and target', () => {
    const source = makeConfig({ host: '10.0.0.1', port: 6379, password: 'srcpass' });
    const target = makeConfig({ host: '10.0.0.2', port: 6380, password: 'tgtpass' });

    const toml = buildSyncReaderToml(source, target, false);

    expect(toml).toContain('[sync_reader]');
    expect(toml).toContain('cluster = false');
    expect(toml).toContain('address = "10.0.0.1:6379"');
    expect(toml).toContain('password = "srcpass"');
    expect(toml).toContain('sync_rdb = true');
    expect(toml).toContain('sync_aof = true');
    expect(toml).toContain('prefer_replica = false');
    expect(toml).toContain('[redis_writer]');
    expect(toml).toContain('address = "10.0.0.2:6380"');
    expect(toml).toContain('password = "tgtpass"');
  });

  it('should set cluster = true for cluster source', () => {
    const source = makeConfig();
    const target = makeConfig();

    const toml = buildSyncReaderToml(source, target, true);

    expect(toml).toContain('cluster = true');
    expect(toml).not.toContain('[scan_reader]');
  });

  it('should emit cluster = false in writer when target is standalone (default)', () => {
    const toml = buildSyncReaderToml(makeConfig(), makeConfig(), false);
    const writerSection = toml.split('[redis_writer]')[1];
    expect(writerSection).toContain('cluster = false');
  });

  it('should emit cluster = true in writer when target is a cluster', () => {
    const toml = buildSyncReaderToml(makeConfig(), makeConfig(), false, {}, true);
    const writerSection = toml.split('[redis_writer]')[1];
    expect(writerSection).toContain('cluster = true');
  });

  it('should combine cluster source, prefer_replica, and cluster target', () => {
    const toml = buildSyncReaderToml(makeConfig(), makeConfig(), true, { preferReplica: true }, true);
    // sync_reader section: cluster = true
    const readerSection = toml.split('[redis_writer]')[0];
    expect(readerSection).toContain('cluster = true');
    expect(readerSection).toContain('prefer_replica = true');
    // writer section: cluster = true
    const writerSection = toml.split('[redis_writer]')[1];
    expect(writerSection).toContain('cluster = true');
  });

  it('should set prefer_replica = true when option is set', () => {
    const source = makeConfig();
    const target = makeConfig();

    const toml = buildSyncReaderToml(source, target, false, { preferReplica: true });

    expect(toml).toContain('prefer_replica = true');
  });

  it('should default prefer_replica to false when options omitted', () => {
    const source = makeConfig();
    const target = makeConfig();

    const toml = buildSyncReaderToml(source, target, false);

    expect(toml).toContain('prefer_replica = false');
  });

  it('should default prefer_replica to false when options is empty object', () => {
    const source = makeConfig();
    const target = makeConfig();

    const toml = buildSyncReaderToml(source, target, false, {});

    expect(toml).toContain('prefer_replica = false');
  });

  it('should treat preferReplica explicitly false the same as omitted', () => {
    const source = makeConfig();
    const target = makeConfig();

    const toml = buildSyncReaderToml(source, target, false, { preferReplica: false });

    expect(toml).toContain('prefer_replica = false');
  });

  it('should escape special characters in passwords', () => {
    const source = makeConfig({ password: 'pass"word\\with\nnewline' });
    const target = makeConfig({ password: 'simple' });

    const toml = buildSyncReaderToml(source, target, false);

    expect(toml).toContain('pass\\"word\\\\with\\nnewline');
    expect(toml).not.toContain('pass"word');
  });

  it('should set tls = true when TLS enabled', () => {
    const source = makeConfig({ tls: true });
    const target = makeConfig({ tls: true });

    const toml = buildSyncReaderToml(source, target, false);

    const readerSection = toml.split('[redis_writer]')[0];
    const writerSection = toml.split('[redis_writer]')[1];
    expect(readerSection).toContain('tls = true');
    expect(writerSection).toContain('tls = true');
  });

  it('should use empty string for "default" username', () => {
    const source = makeConfig({ username: 'default' });
    const target = makeConfig({ username: 'default' });

    const toml = buildSyncReaderToml(source, target, false);

    expect(toml).toContain('username = ""');
  });

  it('should reject control characters in password', () => {
    const source = makeConfig({ password: 'pass\x00word' });
    const target = makeConfig();

    expect(() => buildSyncReaderToml(source, target, false)).toThrow('control characters');
  });

  it('should reject invalid port', () => {
    const source = makeConfig({ port: 99999 as any });
    const target = makeConfig();

    expect(() => buildSyncReaderToml(source, target, false)).toThrow('Invalid port');
  });

  it('should wrap bare IPv6 addresses in brackets for Go net.Dial', () => {
    const source = makeConfig({ host: '::1', port: 6379 });
    const target = makeConfig({ host: '2001:db8::1', port: 6380 });

    const toml = buildSyncReaderToml(source, target, false);

    expect(toml).toContain('address = "[::1]:6379"');
    expect(toml).toContain('address = "[2001:db8::1]:6380"');
  });

  it('should include [advanced] section with log_level', () => {
    const source = makeConfig();
    const target = makeConfig();

    const toml = buildSyncReaderToml(source, target, false);

    expect(toml).toContain('[advanced]');
    expect(toml).toContain('log_level = "info"');
  });

  it('should not emit scan_reader section', () => {
    const source = makeConfig();
    const target = makeConfig();

    const toml = buildSyncReaderToml(source, target, false);

    expect(toml).not.toContain('[scan_reader]');
  });
});
