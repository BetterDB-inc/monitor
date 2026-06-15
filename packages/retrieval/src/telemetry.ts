export type RetrievalOperation = 'upsert' | 'query';

export interface RetrievalMetrics {
  observeOperation(operation: RetrievalOperation, seconds: number): void;
  recordQueryResults(count: number): void;
  recordEmbeddingCall(): void;
}

export interface RetrievalSpan {
  end(): void;
}

export interface RetrievalTracer {
  startSpan(name: string): RetrievalSpan;
}
