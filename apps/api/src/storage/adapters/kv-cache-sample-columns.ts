import type { KvCacheSampleCounters } from '@betterdb/shared';

export const KV_CACHE_SAMPLE_COUNTER_COLUMNS = [
  'requested_tokens',
  'hit_tokens',
  'lookup_tokens',
  'lookup_hits',
  'remote_read_bytes',
  'remote_write_bytes',
  'remote_read_requests',
  'remote_write_requests',
  'remote_ping_errors',
] as const;

export const KV_CACHE_SAMPLE_COUNTER_FIELDS: ReadonlyArray<keyof KvCacheSampleCounters> = [
  'requestedTokens',
  'hitTokens',
  'lookupTokens',
  'lookupHits',
  'remoteReadBytes',
  'remoteWriteBytes',
  'remoteReadRequests',
  'remoteWriteRequests',
  'remotePingErrors',
];
