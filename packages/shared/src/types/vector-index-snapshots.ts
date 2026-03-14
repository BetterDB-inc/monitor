export interface VectorIndexSnapshot {
  id: string;
  timestamp: number;
  connectionId: string;
  indexName: string;
  numDocs: number;
  memorySizeMb: number;
}

export interface VectorIndexSnapshotQueryOptions {
  connectionId?: string;
  indexName?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}
