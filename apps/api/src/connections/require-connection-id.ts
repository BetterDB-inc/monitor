import { NotFoundException } from '@nestjs/common';
import { ConnectionRegistry } from './connection-registry.service';

/**
 * Resolve the connection id a controller should operate on. Validates an
 * explicit `requestedId` against the registry, or falls back to the
 * configured default. Throws NotFoundException with a stable message when
 * no connection can be resolved.
 */
export function requireConnectionId(
  registry: ConnectionRegistry,
  requestedId: string | undefined,
): string {
  if (requestedId) {
    registry.get(requestedId);
    return requestedId;
  }
  const defaultId = registry.getDefaultId();
  if (!defaultId) {
    throw new NotFoundException(
      'No connection available. Pass x-connection-id header or configure a default connection.',
    );
  }
  return defaultId;
}
