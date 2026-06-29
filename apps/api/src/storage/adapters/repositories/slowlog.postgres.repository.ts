import { Pool } from 'pg';
import {
  SlowLogQueryOptions,
  StoredSlowLogEntry,
} from '../../../common/interfaces/storage-port.interface';
import { RowMappers } from '../base-sql.adapter';

export class SlowLogPostgresRepository {
  constructor(
    private readonly pool: Pool,
    private readonly mappers: RowMappers,
  ) {}

  async saveSlowLogEntries(entries: StoredSlowLogEntry[], connectionId: string): Promise<number> {
    if (entries.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const entry of entries) {
      placeholders.push(`(
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}
      )`);
      values.push(
        entry.id,
        entry.timestamp,
        entry.duration,
        entry.command, // PostgreSQL will accept string[] for TEXT[]
        entry.clientAddress || '',
        entry.clientName || '',
        entry.capturedAt,
        entry.sourceHost,
        entry.sourcePort,
        connectionId,
      );
    }

    const query = `
      INSERT INTO slow_log_entries (
        slowlog_id, timestamp, duration, command,
        client_address, client_name, captured_at, source_host, source_port, connection_id
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (slowlog_id, source_host, source_port, connection_id) DO NOTHING
    `;

    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getSlowLogEntries(options: SlowLogQueryOptions = {}): Promise<StoredSlowLogEntry[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(options.endTime);
    }
    if (options.command) {
      // Search in the first element of command array (the command name)
      conditions.push(`command[1] ILIKE $${paramIndex++}`);
      params.push(`%${options.command}%`);
    }
    if (options.clientName) {
      conditions.push(`client_name ILIKE $${paramIndex++}`);
      params.push(`%${options.clientName}%`);
    }
    if (options.minDuration) {
      conditions.push(`duration >= $${paramIndex++}`);
      params.push(options.minDuration);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(
      `SELECT
        slowlog_id, timestamp, duration, command,
        client_address, client_name, captured_at, source_host, source_port, connection_id
      FROM slow_log_entries
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    );

    return result.rows.map((row) => this.mappers.mapSlowLogEntryRow(row));
  }

  async getLatestSlowLogId(connectionId?: string): Promise<number | null> {
    if (connectionId) {
      const result = await this.pool.query(
        'SELECT MAX(slowlog_id) as max_id FROM slow_log_entries WHERE connection_id = $1',
        [connectionId],
      );
      const maxId = result.rows[0]?.max_id;
      return maxId !== null && maxId !== undefined ? Number(maxId) : null;
    }

    const result = await this.pool.query('SELECT MAX(slowlog_id) as max_id FROM slow_log_entries');

    const maxId = result.rows[0]?.max_id;
    return maxId !== null && maxId !== undefined ? Number(maxId) : null;
  }

  async pruneOldSlowLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM slow_log_entries WHERE captured_at < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query('DELETE FROM slow_log_entries WHERE captured_at < $1', [
      cutoffTimestamp,
    ]);

    return result.rowCount ?? 0;
  }
}
