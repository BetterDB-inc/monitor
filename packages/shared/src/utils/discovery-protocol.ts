export const REGISTRY_KEY = '__betterdb:caches';

export const PROTOCOL_KEY = '__betterdb:protocol';

export const HEARTBEAT_KEY_PREFIX = '__betterdb:heartbeat:';

export const DISCOVERY_PROTOCOL_VERSION = 1;

export function heartbeatKeyFor(cacheName: string): string {
  return `${HEARTBEAT_KEY_PREFIX}${cacheName}`;
}
