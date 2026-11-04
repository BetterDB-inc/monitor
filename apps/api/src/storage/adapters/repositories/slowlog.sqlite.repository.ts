import type Database from 'better-sqlite3';
import { chunkedSqliteDelete } from '../sqlite-chunked-delete';
import {
  LogSource,
  SlowLogQueryOptions,
  StoredSlowLogEntry,
} from '../../../common/interfaces/storage-port.interface';
import { RowMappers } from '../base-sql.adapter';

export class SlowLogSqliteRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly mappers: RowMappers,
  ) {}

  async saveSlowLogEntries(entries: StoredSlowLogEntry[], connectionId: string): Promise<number> {
    if (entries.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO slow_log_entries (
        slowlog_id, timestamp, duration, command,
        client_address, client_name, captured_at, source_host, source_port, source_run_id, connection_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const transaction = this.db.transaction((connId: string) => {
      for (const entry of entries) {
        const result = stmt.run(
          entry.id,
          entry.timestamp,
          entry.duration,
          JSON.stringify(entry.command), // Store as JSON string
          entry.clientAddress || '',
          entry.clientName || '',
          entry.capturedAt,
          entry.sourceHost,
          entry.sourcePort,
          entry.sourceRunId ?? '',
          connId,
        );
        count += result.changes;
      }
    });
    transaction(connectionId);

    return count;
  }

  async getSlowLogEntries(options: SlowLogQueryOptions = {}): Promise<StoredSlowLogEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.connectionId) {
      conditions.push('connection_id = ?');
      params.push(options.connectionId);
    }
    if (options.startTime) {
      conditions.push('timestamp >= ?');
      params.push(options.startTime);
    }
    if (options.endTime) {
      conditions.push('timestamp <= ?');
      params.push(options.endTime);
    }
    if (options.command) {
      conditions.push('command LIKE ?');
      params.push(`%${options.command}%`);
    }
    if (options.clientName) {
      conditions.push('client_name LIKE ?');
      params.push(`%${options.clientName}%`);
    }
    if (options.minDuration) {
      conditions.push('duration >= ?');
      params.push(options.minDuration);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    // `magnitude` returns the worst offenders first (top-N by duration); uses the
    // idx_slowlog_duration index. Default `recent` is newest-first.
    const orderBy =
      options.sortBy === 'magnitude'
        ? 'ORDER BY duration DESC, timestamp DESC'
        : 'ORDER BY timestamp DESC';

    const rows = this.db
      .prepare(
        `SELECT slowlog_id, timestamp, duration, command,
              client_address, client_name, captured_at, source_host, source_port, connection_id
       FROM slow_log_entries
       ${whereClause}
       ${orderBy}
       LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    return rows.map((row) => this.mappers.mapSlowLogEntryRow(row));
  }

  async getLatestSlowLogId(connectionId?: string, source?: LogSource): Promise<number | null> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (connectionId) {
      conditions.push('connection_id = ?');
      params.push(connectionId);
    }
    if (source) {
      conditions.push('source_run_id = ?');
      params.push(source.runId ?? '');
      if (!source.runId) {
        conditions.push('source_host = ?', 'source_port = ?');
        params.push(source.host, source.port);
      }
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db
      .prepare(`SELECT MAX(slowlog_id) as max_id FROM slow_log_entries${where}`)
      .get(...params) as { max_id: number | null } | undefined;
    return row?.max_id ?? null;
  }

  async pruneOldSlowLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (connectionId) {
      return chunkedSqliteDelete(this.db, 'slow_log_entries', 'captured_at < ? AND connection_id = ?', [
        cutoffTimestamp,
        connectionId,
      ]);
    }

    return chunkedSqliteDelete(this.db, 'slow_log_entries', 'captured_at < ?', [cutoffTimestamp]);
  }
}
