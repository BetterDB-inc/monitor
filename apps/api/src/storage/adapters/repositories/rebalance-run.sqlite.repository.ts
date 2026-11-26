import type Database from 'better-sqlite3';
import type {
  RebalanceRunQueryOptions,
  StoredRebalanceRun,
} from '../../../common/interfaces/storage-port.interface';
import { chunkedSqliteDelete } from '../sqlite-chunked-delete';
import { rebalanceRunLimit } from './rebalance-run.memory.repository';

interface RebalanceRunRow {
  id: string;
  connection_id: string;
  source_shard_id: string;
  state: StoredRebalanceRun['state'];
  started_at: number;
  ended_at: number | null;
  updated_at: number;
  payload: string;
}

const toStoredRun = (row: RebalanceRunRow): StoredRebalanceRun => ({
  id: row.id,
  connectionId: row.connection_id,
  sourceShardId: row.source_shard_id,
  state: row.state,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  updatedAt: row.updated_at,
  payload: row.payload,
});

export class RebalanceRunSqliteRepository {
  constructor(private readonly db: Database.Database) {}

  async saveRebalanceRun(run: StoredRebalanceRun): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO slot_rebalance_runs
           (id, connection_id, source_shard_id, state, started_at, ended_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           ended_at = excluded.ended_at,
           updated_at = excluded.updated_at,
           payload = excluded.payload
         WHERE excluded.updated_at >= slot_rebalance_runs.updated_at`,
      )
      .run(
        run.id,
        run.connectionId,
        run.sourceShardId,
        run.state,
        run.startedAt,
        run.endedAt,
        run.updatedAt,
        run.payload,
      );
  }

  async getRebalanceRuns(options: RebalanceRunQueryOptions): Promise<StoredRebalanceRun[]> {
    const conditions = ['connection_id = ?'];
    const params: Array<string | number> = [options.connectionId];
    if (options.since !== undefined) {
      conditions.push('started_at >= ?');
      params.push(options.since);
    }
    if (options.states) {
      conditions.push(`state IN (${options.states.map(() => '?').join(', ')})`);
      params.push(...options.states);
    }
    params.push(rebalanceRunLimit(options.limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM slot_rebalance_runs
         WHERE ${conditions.join(' AND ')}
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(...params) as RebalanceRunRow[];
    return rows.map(toStoredRun);
  }

  async pruneOldRebalanceRuns(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const ended = 'ended_at IS NOT NULL AND ended_at < ?';
    if (connectionId) {
      return chunkedSqliteDelete(this.db, 'slot_rebalance_runs', `${ended} AND connection_id = ?`, [
        cutoffTimestamp,
        connectionId,
      ]);
    }
    return chunkedSqliteDelete(this.db, 'slot_rebalance_runs', ended, [cutoffTimestamp]);
  }
}
