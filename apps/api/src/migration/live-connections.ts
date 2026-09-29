import { BadRequestException } from '@nestjs/common';
import type { ConnectionRegistry } from '../connections/connection-registry.service';

export const EXTERNAL_MIGRATION_MESSAGE =
  'One or more selected instances only pushes OTLP metrics. Migration needs a live connection to both instances.';

export const CLUSTER_MEMBER_MIGRATION_MESSAGE =
  'One or more selected instances is a node registered under a cluster seed. Pick the cluster seed instead.';

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
}
