export type FieldSpec =
  | { type: 'text' }
  | { type: 'tag'; separator?: string }
  | { type: 'numeric'; sortable?: boolean };

export type VectorMetric = 'cosine' | 'l2' | 'ip';
export type VectorAlgorithm = 'hnsw' | 'flat';

export interface VectorSpecBase {
  metric: VectorMetric;
  dims?: number;
  fieldName?: string;
}

export interface HnswVectorSpec extends VectorSpecBase {
  algorithm: 'hnsw';
  m?: number;
  efConstruction?: number;
  efRuntime?: number;
}

export interface FlatVectorSpec extends VectorSpecBase {
  algorithm: 'flat';
}

export type VectorSpec = HnswVectorSpec | FlatVectorSpec;

export interface RetrievalSchema {
  fields: Record<string, FieldSpec>;
  vector: VectorSpec;
}

export interface FtCapabilities {
  textFields?: boolean;
}
