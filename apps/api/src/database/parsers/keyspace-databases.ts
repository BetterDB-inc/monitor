import type { KeyspaceInfo } from '../../common/types/metrics.types';

export interface KeyspaceDatabase {
  db: number;
  keys: number;
}

export function parseKeyspaceDatabases(keyspace: KeyspaceInfo | undefined): KeyspaceDatabase[] {
  const dbs: KeyspaceDatabase[] = [];
  for (const [key, info] of Object.entries(keyspace ?? {})) {
    const match = /^db(\d+)$/.exec(key);
    if (match && typeof info === 'object' && info.keys > 0) {
      dbs.push({ db: parseInt(match[1], 10), keys: info.keys });
    }
  }
  return dbs.sort((a, b) => a.db - b.db);
}
