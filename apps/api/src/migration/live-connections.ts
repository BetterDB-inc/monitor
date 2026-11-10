import { BadRequestException } from '@nestjs/common';
import { hasClientCertificate, type DatabaseConnectionConfig, type ExecutionMode } from '@betterdb/shared';
import type { ConnectionRegistry } from '../connections/connection-registry.service';
import { usesSshTunnel } from './migration-endpoints';

export const EXTERNAL_MIGRATION_MESSAGE =
  'One or more selected instances only pushes OTLP metrics. Migration needs a live connection to both instances.';

export const CLUSTER_MEMBER_MIGRATION_MESSAGE =
  'One or more selected instances is a node registered under a cluster seed. Pick the cluster seed instead.';

export const SSH_TUNNEL_CLUSTER_MIGRATION_MESSAGE =
  'One or more selected instances is a cluster reached through an SSH tunnel. Only the configured node is tunnelled, so migration cannot reach the other nodes. Use a connection BetterDB can reach directly.';

export const SSH_TUNNEL_PREFER_REPLICA_MESSAGE =
  'Reading from a replica is not available when the source is reached through an SSH tunnel: RedisShake would connect to the replica directly and bypass the tunnel. Turn off the replica option.';

export const AGENT_MIGRATION_MESSAGE =
  'One or more selected instances is connected through the BetterDB Agent. Execution and validation need a direct or SSH-tunnelled connection; an agent connection supports analysis only.';

export const CLIENT_CERT_SHAKE_MIGRATION_MESSAGE =
  'One or more selected instances authenticates with a client certificate. RedisShake cannot present one yet; use command mode.';

/** True when a connection relies on a client certificate (mutual TLS) to connect or authenticate. */
function usesClientCertificate(config: DatabaseConnectionConfig | null): boolean {
  return config?.authMode === 'certificate' || hasClientCertificate(config?.tlsConfig);
}

function isAgentConnection(config: DatabaseConnectionConfig | null): boolean {
  return config?.host === 'agent';
}

export function assertAddressableEndpoints(
  source: DatabaseConnectionConfig | null,
  target: DatabaseConnectionConfig | null,
): void {
  if (isAgentConnection(source) || isAgentConnection(target)) {
    throw new BadRequestException(AGENT_MIGRATION_MESSAGE);
  }
}

export interface TunnelTopology {
  sourceIsCluster: boolean;
  targetIsCluster?: boolean;
  preferReplica?: boolean;
}

export function assertTunnelSupport(
  source: DatabaseConnectionConfig | null,
  target: DatabaseConnectionConfig | null,
  topology: TunnelTopology,
): void {
  const tunnelledClusterSource = usesSshTunnel(source) && topology.sourceIsCluster;
  const tunnelledClusterTarget = usesSshTunnel(target) && topology.targetIsCluster === true;
  if (tunnelledClusterSource || tunnelledClusterTarget) {
    throw new BadRequestException(SSH_TUNNEL_CLUSTER_MIGRATION_MESSAGE);
  }
  if (usesSshTunnel(source) && topology.preferReplica === true) {
    throw new BadRequestException(SSH_TUNNEL_PREFER_REPLICA_MESSAGE);
  }
}

export function assertLiveMigrationPair(
  registry: Pick<ConnectionRegistry, 'getConfig'>,
  sourceConnectionId: string,
  targetConnectionId: string | undefined,
  mode?: ExecutionMode,
): void {
  const source = registry.getConfig(sourceConnectionId);
  const target = targetConnectionId === undefined ? null : registry.getConfig(targetConnectionId);
  if (source?.connectionType === 'external' || target?.connectionType === 'external') {
    throw new BadRequestException(EXTERNAL_MIGRATION_MESSAGE);
  }
  if (source?.membership || target?.membership) {
    throw new BadRequestException(CLUSTER_MEMBER_MIGRATION_MESSAGE);
  }
  if (mode !== undefined) {
    assertAddressableEndpoints(source, target);
  }
  // The RedisShake TOML carries only `tls = true`, no client certificate, so a
  // shake job against an mTLS instance would flush the target (emptyDbBeforeSync
  // runs through BetterDB's own mTLS-capable client) and then fail the handshake.
  if (mode !== undefined && mode !== 'command' && (usesClientCertificate(source) || usesClientCertificate(target))) {
    throw new BadRequestException(CLIENT_CERT_SHAKE_MIGRATION_MESSAGE);
  }
}
