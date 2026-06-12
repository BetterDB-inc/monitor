export type FieldSpec =
  | { type: 'text' }
  | { type: 'tag'; separator?: string }
  | { type: 'numeric'; sortable?: boolean };

export type VectorMetric = 'cosine' | 'l2' | 'ip';
export type VectorAlgorithm = 'hnsw' | 'flat';

export interface VectorSpec {
  metric: VectorMetric;
  algorithm: VectorAlgorithm;
  dims?: number;
  fieldName?: string;
  m?: number;
  efConstruction?: number;
  efRuntime?: number;
}

export interface RetrievalSchema {
  fields: Record<string, FieldSpec>;
  vector: VectorSpec;
}

export interface FtCapabilities {
  textFields?: boolean;
}
