import { BadRequestException } from '@nestjs/common';
import type { ConnectionRegistry } from '../connections/connection-registry.service';

export const EXTERNAL_MIGRATION_MESSAGE =
  'One or more selected instances only pushes OTLP metrics. Migration needs a live connection to both instances.';

export function assertLiveMigrationPair(
  registry: Pick<ConnectionRegistry, 'getConfig'>,
  sourceConnectionId: string,
  targetConnectionId: string,
): void {
  const isExternal = (id: string) => registry.getConfig(id)?.connectionType === 'external';
  if (isExternal(sourceConnectionId) || isExternal(targetConnectionId)) {
    throw new BadRequestException(EXTERNAL_MIGRATION_MESSAGE);
  }
}
