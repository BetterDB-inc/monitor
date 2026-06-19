import { indexName } from './ft-create';

export const REGISTRY_KEY = '__betterdb:caches';
export const RETRIEVAL_PROTOCOL_VERSION = 1;
export const RETRIEVAL_CACHE_TYPE = 'retrieval' as const;
// TODO: sync with package.json rather than hardcoding (deferred follow-up) —
// this drifts on a version bump.
export const RETRIEVAL_VERSION = '0.1.0';

export interface RetrievalMarker {
  type: typeof RETRIEVAL_CACHE_TYPE;
  prefix: string;
  version: string;
  protocol_version: number;
  capabilities: string[];
  index_name: string;
  started_at: string;
}

export interface BuildRetrievalMarkerInput {
  name: string;
  version: string;
  startedAt: string;
}

export function buildRetrievalMarker(input: BuildRetrievalMarkerInput): RetrievalMarker {
  return {
    type: RETRIEVAL_CACHE_TYPE,
    prefix: input.name,
    version: input.version,
    protocol_version: RETRIEVAL_PROTOCOL_VERSION,
    capabilities: ['upsert', 'query', 'delete'],
    index_name: indexName(input.name),
    started_at: input.startedAt,
  };
}
