export interface VectorIndexSnapshot {
  id: string;
  timestamp: number;
  connectionId: string;
  indexName: string;
  numDocs: number;
  numRecords: number;
  numDeletedDocs: number;
  indexingFailures: number;
  indexingFailuresDelta: number;
  percentIndexed: number;
  indexingState: string;
  totalIndexingTime: number;
  memorySizeMb: number;
}

export interface VectorIndexSnapshotQueryOptions {
  connectionId?: string;
  indexName?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}
