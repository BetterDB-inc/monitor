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
