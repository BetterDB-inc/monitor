import type Database from 'better-sqlite3';
import type { Pool } from 'pg';
import type { StoragePort } from '../common/interfaces/storage-port.interface';

export type RawDatabaseHandle =
  | { kind: 'sqlite'; db: Database.Database }
  | { kind: 'libsql'; db: Database.Database }
  | { kind: 'postgres'; pool: Pool }
  | { kind: 'memory' };

export interface RawDatabaseHandleProvider {
  getRawDatabaseHandle(): RawDatabaseHandle;
}

export function hasRawDatabaseHandle(
  storage: StoragePort,
): storage is StoragePort & RawDatabaseHandleProvider {
  const candidate = storage as Partial<RawDatabaseHandleProvider>;
  return typeof candidate.getRawDatabaseHandle === 'function';
}
