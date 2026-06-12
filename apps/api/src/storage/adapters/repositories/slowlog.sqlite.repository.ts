import Database from 'better-sqlite3';
import {
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
        client_address, client_name, captured_at, source_host, source_port, connection_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const params: any[] = [];

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

    const rows = this.db
      .prepare(
        `SELECT slowlog_id, timestamp, duration, command,
              client_address, client_name, captured_at, source_host, source_port, connection_id
       FROM slow_log_entries
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as any[];

    return rows.map((row) => this.mappers.mapSlowLogEntryRow(row));
  }

  async getLatestSlowLogId(connectionId?: string): Promise<number | null> {
    if (connectionId) {
      const row = this.db
        .prepare('SELECT MAX(slowlog_id) as max_id FROM slow_log_entries WHERE connection_id = ?')
        .get(connectionId) as any;
      return row?.max_id ?? null;
    }

    const row = this.db
      .prepare('SELECT MAX(slowlog_id) as max_id FROM slow_log_entries')
      .get() as any;
    return row?.max_id ?? null;
  }

  async pruneOldSlowLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (connectionId) {
      const result = this.db
        .prepare('DELETE FROM slow_log_entries WHERE captured_at < ? AND connection_id = ?')
        .run(cutoffTimestamp, connectionId);
      return result.changes;
    }

    const result = this.db
      .prepare('DELETE FROM slow_log_entries WHERE captured_at < ?')
      .run(cutoffTimestamp);
    return result.changes;
  }
}
