import { BadRequestException } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import {
  CLIENT_CERT_SHAKE_MIGRATION_MESSAGE,
  CLUSTER_MEMBER_MIGRATION_MESSAGE,
  EXTERNAL_MIGRATION_MESSAGE,
  SSH_TUNNEL_MIGRATION_MESSAGE,
  assertLiveMigrationPair,
} from '../live-connections';

const configs: Record<string, Partial<DatabaseConnectionConfig>> = {
  seed: { id: 'seed', connectionType: 'direct' },
  other: { id: 'other', connectionType: 'direct' },
  child: { id: 'child', connectionType: 'direct', membership: { seedId: 'seed', nodeId: 'n', origin: 'auto', source: 'cluster' } },
  pushed: { id: 'pushed', connectionType: 'external' },
  tunneled: {
    id: 'tunneled',
    connectionType: 'direct',
    sshTunnel: { enabled: true, host: 'bastion', port: 22, username: 'ops', authMethod: 'password' },
  },
  tunnelOff: {
    id: 'tunnelOff',
    connectionType: 'direct',
    sshTunnel: { enabled: false, host: 'bastion', port: 22, username: 'ops', authMethod: 'password' },
  },
  certAuth: { id: 'certAuth', connectionType: 'direct', tls: true, authMode: 'certificate', tlsConfig: { cert: 'C', key: 'K' } },
  clientCert: { id: 'clientCert', connectionType: 'direct', tls: true, tlsConfig: { source: 'file', certPath: 'c.crt', keyPath: 'c.key' } },
  caOnly: { id: 'caOnly', connectionType: 'direct', tls: true, tlsConfig: { ca: 'CA' } },
};
const registry = { getConfig: (id: string) => (configs[id] ?? null) as DatabaseConnectionConfig | null };

describe('assertLiveMigrationPair', () => {
  it('allows two standalone live connections', () => {
    expect(() => assertLiveMigrationPair(registry, 'seed', 'other')).not.toThrow();
  });

  describe('client certificates (mutual TLS)', () => {
    it.each(['redis_shake', 'redis_shake_sync'] as const)('rejects %s when either side presents a client certificate', (mode) => {
      expect(() => assertLiveMigrationPair(registry, 'certAuth', 'other', mode)).toThrow(CLIENT_CERT_SHAKE_MIGRATION_MESSAGE);
      expect(() => assertLiveMigrationPair(registry, 'seed', 'clientCert', mode)).toThrow(CLIENT_CERT_SHAKE_MIGRATION_MESSAGE);
      expect(() => assertLiveMigrationPair(registry, 'certAuth', undefined, mode)).toThrow(CLIENT_CERT_SHAKE_MIGRATION_MESSAGE);
    });

    it('allows command mode, which uses BetterDB\'s own mTLS-capable clients', () => {
      expect(() => assertLiveMigrationPair(registry, 'certAuth', 'clientCert', 'command')).not.toThrow();
    });

    it('does not treat a custom CA alone as a client certificate', () => {
      expect(() => assertLiveMigrationPair(registry, 'caOnly', 'other', 'redis_shake')).not.toThrow();
    });

    it('stays permissive when no mode is given (analysis)', () => {
      expect(() => assertLiveMigrationPair(registry, 'certAuth', 'other')).not.toThrow();
    });
  });

  it('checks only the source when there is no target connection', () => {
    expect(() => assertLiveMigrationPair(registry, 'seed', undefined)).not.toThrow();
    expect(() => assertLiveMigrationPair(registry, 'pushed', undefined)).toThrow(EXTERNAL_MIGRATION_MESSAGE);
    expect(() => assertLiveMigrationPair(registry, 'child', undefined)).toThrow(CLUSTER_MEMBER_MIGRATION_MESSAGE);
    expect(() => assertLiveMigrationPair(registry, 'tunneled', undefined)).toThrow(SSH_TUNNEL_MIGRATION_MESSAGE);
  });

  it('rejects an OTLP push endpoint', () => {
    expect(() => assertLiveMigrationPair(registry, 'seed', 'pushed')).toThrow(EXTERNAL_MIGRATION_MESSAGE);
  });

  it.each([
    ['seed', 'child'],
    ['child', 'other'],
  ])('rejects a cluster member endpoint (%s -> %s)', (source, target) => {
    expect(() => assertLiveMigrationPair(registry, source, target)).toThrow(BadRequestException);
    expect(() => assertLiveMigrationPair(registry, source, target)).toThrow(CLUSTER_MEMBER_MIGRATION_MESSAGE);
  });

  it.each([
    ['tunneled', 'other'],
    ['seed', 'tunneled'],
  ])('rejects an SSH-tunneled endpoint (%s -> %s)', (source, target) => {
    expect(() => assertLiveMigrationPair(registry, source, target)).toThrow(BadRequestException);
    expect(() => assertLiveMigrationPair(registry, source, target)).toThrow(SSH_TUNNEL_MIGRATION_MESSAGE);
  });

  it('allows a connection whose saved tunnel is disabled', () => {
    expect(() => assertLiveMigrationPair(registry, 'tunnelOff', 'other')).not.toThrow();
  });
});
