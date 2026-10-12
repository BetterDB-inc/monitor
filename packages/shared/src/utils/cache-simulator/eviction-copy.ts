const COPY: Record<string, string> = {
  noeviction: 'Writes start failing with OOM errors once memory is full; reads keep working.',
  'allkeys-lru': 'The least recently used keys are evicted to make room, whether or not they have a TTL.',
  'allkeys-lfu': 'The least frequently used keys are evicted to make room, whether or not they have a TTL.',
  'allkeys-random': 'Random keys are evicted to make room, whether or not they have a TTL.',
  'allkeys-lrm': 'The least recently modified keys are evicted to make room, whether or not they have a TTL.',
  'volatile-lru': 'The least recently used keys that have a TTL are evicted; once none are left, writes fail with OOM errors.',
  'volatile-lfu': 'The least frequently used keys that have a TTL are evicted; once none are left, writes fail with OOM errors.',
  'volatile-random': 'Random keys that have a TTL are evicted; once none are left, writes fail with OOM errors.',
  'volatile-ttl': 'Keys closest to expiring are evicted first; once no keys with a TTL are left, writes fail with OOM errors.',
  'volatile-lrm': 'The least recently modified keys that have a TTL are evicted; once none are left, writes fail with OOM errors.',
};

export const EVICTION_POLICIES = Object.keys(COPY);

export const UNKNOWN_EVICTION_COPY = 'This eviction policy is not recognised, so its behaviour at maxmemory cannot be described.';

export function evictionConsequence(policy: string): string {
  return COPY[policy.toLowerCase()] ?? UNKNOWN_EVICTION_COPY;
}
