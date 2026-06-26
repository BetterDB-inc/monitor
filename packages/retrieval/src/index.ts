export type {
  FieldSpec,
  VectorMetric,
  VectorAlgorithm,
  VectorSpecBase,
  HnswVectorSpec,
  FlatVectorSpec,
  VectorSpec,
  RetrievalSchema,
  FtCapabilities,
} from './schema';
export { buildFtCreateArgs, indexName, keyPrefix, resolveVectorFieldName } from './ft-create';
export { TEXT_FIELD, SCORE_FIELD } from './fields';
export { buildFtSearchQuery } from './ft-search';
export type { QueryFilter } from './ft-search';
export { Retriever } from './retriever';
export type {
  RetrieverClient,
  RetrieverOptions,
  IndexDescription,
  EmbedFn,
  UpsertEntry,
  RerankFn,
  QueryHit,
  QueryOptions,
} from './retriever';
export { buildRetrievalMarker, REGISTRY_KEY, RETRIEVAL_CACHE_TYPE } from './discovery';
export type { RetrievalMarker } from './discovery';
export { parsePercentIndexed } from './health';
export type { IndexHealthSnapshot, RecallEstimator } from './health';
export type {
  RetrievalMetrics,
  RetrievalTracer,
  RetrievalSpan,
  RetrievalOperation,
} from './telemetry';
export { createPrometheusMetrics } from './prometheus-metrics';
export type { PrometheusMetricsOptions } from './prometheus-metrics';
export { createAnalytics, NOOP_ANALYTICS } from './analytics';
export type { Analytics, AnalyticsOptions, AnalyticsClient } from './analytics';
