import { BadRequestException } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import {
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
};
const registry = { getConfig: (id: string) => (configs[id] ?? null) as DatabaseConnectionConfig | null };

describe('assertLiveMigrationPair', () => {
  it('allows two standalone live connections', () => {
    expect(() => assertLiveMigrationPair(registry, 'seed', 'other')).not.toThrow();
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
