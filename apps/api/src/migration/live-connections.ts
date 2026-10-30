import { BadRequestException } from '@nestjs/common';
import { hasClientCertificate, type DatabaseConnectionConfig, type ExecutionMode } from '@betterdb/shared';
import type { ConnectionRegistry } from '../connections/connection-registry.service';

export const EXTERNAL_MIGRATION_MESSAGE =
  'One or more selected instances only pushes OTLP metrics. Migration needs a live connection to both instances.';

export const CLUSTER_MEMBER_MIGRATION_MESSAGE =
  'One or more selected instances is a node registered under a cluster seed. Pick the cluster seed instead.';

export const SSH_TUNNEL_MIGRATION_MESSAGE =
  'One or more selected instances is reached through an SSH tunnel. Migration connects to both instances directly and cannot use the tunnel yet.';

export const CLIENT_CERT_SHAKE_MIGRATION_MESSAGE =
  'One or more selected instances authenticates with a client certificate. RedisShake cannot present one yet; use command mode.';

/** True when a connection relies on a client certificate (mutual TLS) to connect or authenticate. */
function usesClientCertificate(config: DatabaseConnectionConfig | null): boolean {
  return config?.authMode === 'certificate' || hasClientCertificate(config?.tlsConfig);
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
  // Analysis reads through the monitoring adapter, which honours the tunnel, but
  // command mode, validation and RedisShake open their own clients against
  // config.host:port and would bypass it. Fail before any of them run: a
  // redis_shake job with emptyDbBeforeSync would otherwise flush the target
  // and then fail to reach the source.
  if (source?.sshTunnel?.enabled === true || target?.sshTunnel?.enabled === true) {
    throw new BadRequestException(SSH_TUNNEL_MIGRATION_MESSAGE);
  }
  // The RedisShake TOML carries only `tls = true`, no client certificate, so a
  // shake job against an mTLS instance would flush the target (emptyDbBeforeSync
  // runs through BetterDB's own mTLS-capable client) and then fail the handshake.
  if (mode !== undefined && mode !== 'command' && (usesClientCertificate(source) || usesClientCertificate(target))) {
    throw new BadRequestException(CLIENT_CERT_SHAKE_MIGRATION_MESSAGE);
  }
}
