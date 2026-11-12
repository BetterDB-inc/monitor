import { BadRequestException } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import {
  CLIENT_CERT_SHAKE_MIGRATION_MESSAGE,
  CLUSTER_MEMBER_MIGRATION_MESSAGE,
  EXTERNAL_MIGRATION_MESSAGE,
  AGENT_MIGRATION_MESSAGE,
  SSH_TUNNEL_CLUSTER_MIGRATION_MESSAGE,
  SSH_TUNNEL_PREFER_REPLICA_MESSAGE,
  SSH_TUNNEL_TLS_SHAKE_MIGRATION_MESSAGE,
  assertAddressableEndpoints,
  assertLiveMigrationPair,
  assertTunnelSupport,
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
  tunneledTls: {
    id: 'tunneledTls',
    connectionType: 'direct',
    tls: true,
    sshTunnel: { enabled: true, host: 'bastion', port: 22, username: 'ops', authMethod: 'password' },
  },
  tunnelOffTls: {
    id: 'tunnelOffTls',
    connectionType: 'direct',
    tls: true,
    sshTunnel: { enabled: false, host: 'bastion', port: 22, username: 'ops', authMethod: 'password' },
  },
  certAuth: { id: 'certAuth', connectionType: 'direct', tls: true, authMode: 'certificate', tlsConfig: { cert: 'C', key: 'K' } },
  clientCert: { id: 'clientCert', connectionType: 'direct', tls: true, tlsConfig: { source: 'file', certPath: 'c.crt', keyPath: 'c.key' } },
  caOnly: { id: 'caOnly', connectionType: 'direct', tls: true, tlsConfig: { ca: 'CA' } },
  agent: { id: 'agent', host: 'agent', port: 0 },
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
    expect(() => assertLiveMigrationPair(registry, 'tunneled', undefined)).not.toThrow();
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

  describe('SSH tunnels', () => {
    it.each([
      ['tunneled', 'other'],
      ['seed', 'tunneled'],
      ['tunneled', 'tunneled'],
    ])('allows a tunnelled endpoint for analysis and validation (%s -> %s)', (source, target) => {
      expect(() => assertLiveMigrationPair(registry, source, target)).not.toThrow();
    });

    it.each(['command', 'redis_shake', 'redis_shake_sync'] as const)('allows a tunnelled endpoint for %s execution', (mode) => {
      expect(() => assertLiveMigrationPair(registry, 'tunneled', 'other', mode)).not.toThrow();
      expect(() => assertLiveMigrationPair(registry, 'seed', 'tunneled', mode)).not.toThrow();
    });

    it.each(['redis_shake', 'redis_shake_sync'] as const)('rejects %s when a tunnelled side uses TLS', (mode) => {
      expect(() => assertLiveMigrationPair(registry, 'tunneledTls', 'other', mode)).toThrow(BadRequestException);
      expect(() => assertLiveMigrationPair(registry, 'tunneledTls', 'other', mode)).toThrow(SSH_TUNNEL_TLS_SHAKE_MIGRATION_MESSAGE);
      expect(() => assertLiveMigrationPair(registry, 'seed', 'tunneledTls', mode)).toThrow(SSH_TUNNEL_TLS_SHAKE_MIGRATION_MESSAGE);
    });

    it('allows command mode for a tunnelled TLS side, which verifies the certificate itself', () => {
      expect(() => assertLiveMigrationPair(registry, 'tunneledTls', 'tunneledTls', 'command')).not.toThrow();
    });

    it('allows analysis and validation of a tunnelled TLS side', () => {
      expect(() => assertLiveMigrationPair(registry, 'tunneledTls', 'other')).not.toThrow();
    });

    it.each(['redis_shake', 'redis_shake_sync'] as const)('allows %s for a TLS side that is not tunnelled', (mode) => {
      expect(() => assertLiveMigrationPair(registry, 'caOnly', 'other', mode)).not.toThrow();
      expect(() => assertLiveMigrationPair(registry, 'seed', 'tunnelOffTls', mode)).not.toThrow();
    });
  });

  it('allows a connection whose saved tunnel is disabled', () => {
    expect(() => assertLiveMigrationPair(registry, 'tunnelOff', 'other')).not.toThrow();
  });

  describe('agent connections', () => {
    it.each(['command', 'redis_shake', 'redis_shake_sync'] as const)('rejects an agent endpoint for %s execution', (mode) => {
      expect(() => assertLiveMigrationPair(registry, 'agent', 'other', mode)).toThrow(BadRequestException);
      expect(() => assertLiveMigrationPair(registry, 'agent', 'other', mode)).toThrow(AGENT_MIGRATION_MESSAGE);
      expect(() => assertLiveMigrationPair(registry, 'seed', 'agent', mode)).toThrow(AGENT_MIGRATION_MESSAGE);
    });

    it('allows an agent endpoint for analysis, which reads through the agent', () => {
      expect(() => assertLiveMigrationPair(registry, 'agent', 'other')).not.toThrow();
    });
  });
});

describe('assertAddressableEndpoints', () => {
  const direct = configs.seed as DatabaseConnectionConfig;

  it('rejects an agent connection on either side', () => {
    expect(() => assertAddressableEndpoints(configs.agent as DatabaseConnectionConfig, direct)).toThrow(AGENT_MIGRATION_MESSAGE);
    expect(() => assertAddressableEndpoints(direct, configs.agent as DatabaseConnectionConfig)).toThrow(AGENT_MIGRATION_MESSAGE);
  });

  it('allows direct and tunnelled connections', () => {
    expect(() => assertAddressableEndpoints(direct, configs.tunneled as DatabaseConnectionConfig)).not.toThrow();
  });
});

describe('assertTunnelSupport', () => {
  const direct = configs.seed as DatabaseConnectionConfig;
  const tunneled = configs.tunneled as DatabaseConnectionConfig;
  const tunnelOff = configs.tunnelOff as DatabaseConnectionConfig;

  it('allows standalone instances on both sides of a tunnel', () => {
    expect(() => assertTunnelSupport(tunneled, tunneled, { sourceIsCluster: false, targetIsCluster: false })).not.toThrow();
  });

  it('rejects a cluster source reached through a tunnel', () => {
    expect(() => assertTunnelSupport(tunneled, direct, { sourceIsCluster: true, targetIsCluster: false })).toThrow(BadRequestException);
    expect(() => assertTunnelSupport(tunneled, direct, { sourceIsCluster: true, targetIsCluster: false })).toThrow(SSH_TUNNEL_CLUSTER_MIGRATION_MESSAGE);
  });

  it('rejects a cluster target reached through a tunnel', () => {
    expect(() => assertTunnelSupport(direct, tunneled, { sourceIsCluster: false, targetIsCluster: true })).toThrow(SSH_TUNNEL_CLUSTER_MIGRATION_MESSAGE);
  });

  it('allows a cluster that is reached directly, even when the other side is tunnelled', () => {
    expect(() => assertTunnelSupport(direct, tunneled, { sourceIsCluster: true, targetIsCluster: false })).not.toThrow();
    expect(() => assertTunnelSupport(tunneled, direct, { sourceIsCluster: false, targetIsCluster: true })).not.toThrow();
  });

  it('allows a cluster whose saved tunnel is disabled', () => {
    expect(() => assertTunnelSupport(tunnelOff, direct, { sourceIsCluster: true, targetIsCluster: false })).not.toThrow();
  });

  it('checks only the source when there is no target', () => {
    expect(() => assertTunnelSupport(tunneled, null, { sourceIsCluster: true })).toThrow(SSH_TUNNEL_CLUSTER_MIGRATION_MESSAGE);
    expect(() => assertTunnelSupport(tunneled, null, { sourceIsCluster: false })).not.toThrow();
  });

  it('rejects prefer_replica when the source is reached through a tunnel', () => {
    expect(() => assertTunnelSupport(tunneled, direct, { sourceIsCluster: false, targetIsCluster: false, preferReplica: true })).toThrow(
      SSH_TUNNEL_PREFER_REPLICA_MESSAGE,
    );
  });

  it('allows prefer_replica when only the target is tunnelled', () => {
    expect(() => assertTunnelSupport(direct, tunneled, { sourceIsCluster: false, targetIsCluster: false, preferReplica: true })).not.toThrow();
  });
});
