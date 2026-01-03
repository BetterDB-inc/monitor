export type { StoredAclEntry, AuditQueryOptions, AuditStats } from '@betterdb/shared';
import type { StoredAclEntry, AuditQueryOptions, AuditStats } from '@betterdb/shared';

export interface StoragePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;
  saveAclEntries(entries: StoredAclEntry[]): Promise<number>;
  getAclEntries(options?: AuditQueryOptions): Promise<StoredAclEntry[]>;
  getAuditStats(startTime?: number, endTime?: number): Promise<AuditStats>;
  pruneOldEntries(olderThanTimestamp: number): Promise<number>;
}
