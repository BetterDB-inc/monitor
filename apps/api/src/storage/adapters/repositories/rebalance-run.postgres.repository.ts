import type { Pool } from 'pg';
import type {
  RebalanceRunQueryOptions,
  StoredRebalanceRun,
} from '../../../common/interfaces/storage-port.interface';
import { chunkedPostgresDelete } from '../postgres-chunked-delete';
import { rebalanceRunLimit } from './rebalance-run.memory.repository';

/** `pg` returns BIGINT columns as strings. */
interface RebalanceRunRow {
  id: string;
  connection_id: string;
  source_shard_id: string;
  state: StoredRebalanceRun['state'];
  started_at: string;
  ended_at: string | null;
  updated_at: string;
  payload: string;
}

const toStoredRun = (row: RebalanceRunRow): StoredRebalanceRun => ({
  id: row.id,
  connectionId: row.connection_id,
  sourceShardId: row.source_shard_id,
  state: row.state,
  startedAt: Number(row.started_at),
  endedAt: row.ended_at === null ? null : Number(row.ended_at),
  updatedAt: Number(row.updated_at),
  payload: row.payload,
});

export class RebalanceRunPostgresRepository {
  constructor(private readonly pool: Pool) {}

  async saveRebalanceRun(run: StoredRebalanceRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO slot_rebalance_runs
         (id, connection_id, source_shard_id, state, started_at, ended_at, updated_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         ended_at = EXCLUDED.ended_at,
         updated_at = EXCLUDED.updated_at,
         payload = EXCLUDED.payload
       WHERE EXCLUDED.updated_at >= slot_rebalance_runs.updated_at`,
      [
        run.id,
        run.connectionId,
        run.sourceShardId,
        run.state,
        run.startedAt,
        run.endedAt,
        run.updatedAt,
        run.payload,
      ],
    );
  }

  async getRebalanceRuns(options: RebalanceRunQueryOptions): Promise<StoredRebalanceRun[]> {
    const params: unknown[] = [];
    const bind = (value: unknown) => `$${params.push(value)}`;
    const conditions = [`connection_id = ${bind(options.connectionId)}`];
    if (options.since !== undefined) conditions.push(`started_at >= ${bind(options.since)}`);
    if (options.states) conditions.push(`state = ANY(${bind(options.states)})`);
    const { rows } = await this.pool.query<RebalanceRunRow>(
      `SELECT * FROM slot_rebalance_runs
       WHERE ${conditions.join(' AND ')}
       ORDER BY started_at DESC
       LIMIT ${bind(rebalanceRunLimit(options.limit))}`,
      params,
    );
    return rows.map(toStoredRun);
  }

  async pruneOldRebalanceRuns(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const ended = 'ended_at IS NOT NULL AND ended_at < $1';
    if (connectionId) {
      return chunkedPostgresDelete(
        this.pool,
        'slot_rebalance_runs',
        `${ended} AND connection_id = $2`,
        [cutoffTimestamp, connectionId],
      );
    }
    return chunkedPostgresDelete(this.pool, 'slot_rebalance_runs', ended, [cutoffTimestamp]);
  }
}
