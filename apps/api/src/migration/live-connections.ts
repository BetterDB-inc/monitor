import { BadRequestException } from '@nestjs/common';
import type { ConnectionRegistry } from '../connections/connection-registry.service';

export const EXTERNAL_MIGRATION_MESSAGE =
  'One or more selected instances only pushes OTLP metrics. Migration needs a live connection to both instances.';

export const CLUSTER_MEMBER_MIGRATION_MESSAGE =
  'One or more selected instances is a node registered under a cluster seed. Pick the cluster seed instead.';

export const SSH_TUNNEL_MIGRATION_MESSAGE =
  'One or more selected instances is reached through an SSH tunnel. Migration connects to both instances directly and cannot use the tunnel yet.';

export function assertLiveMigrationPair(
  registry: Pick<ConnectionRegistry, 'getConfig'>,
  sourceConnectionId: string,
  targetConnectionId: string,
): void {
  const source = registry.getConfig(sourceConnectionId);
  const target = registry.getConfig(targetConnectionId);
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
}
