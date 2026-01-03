import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {
  StoragePort,
  StoredAclEntry,
  AuditQueryOptions,
  AuditStats,
} from '../../common/interfaces/storage-port.interface';

export interface SqliteAdapterConfig {
  filepath: string;
}

export class SqliteAdapter implements StoragePort {
  private db: Database.Database | null = null;
  private ready: boolean = false;

  constructor(private config: SqliteAdapterConfig) {}

  async initialize(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.config.filepath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Open database with WAL mode for better concurrency
      this.db = new Database(this.config.filepath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');

      // Create schema
      this.createSchema();
      this.ready = true;
    } catch (error) {
      this.ready = false;
      throw new Error(`Failed to initialize SQLite: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready && this.db !== null;
  }

  async saveAclEntries(entries: StoredAclEntry[]): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const insert = this.db.prepare(`
      INSERT INTO acl_audit (
        count,
        reason,
        context,
        object,
        username,
        age_seconds,
        client_info,
        timestamp_created,
        timestamp_last_updated,
        captured_at,
        source_host,
        source_port
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(timestamp_created, username, object, reason, source_host, source_port)
      DO UPDATE SET
        count = excluded.count,
        age_seconds = excluded.age_seconds,
        timestamp_last_updated = excluded.timestamp_last_updated,
        captured_at = excluded.captured_at
    `);

    const insertMany = this.db.transaction((entries: StoredAclEntry[]) => {
      for (const entry of entries) {
        insert.run(
          entry.count,
          entry.reason,
          entry.context,
          entry.object,
          entry.username,
          entry.ageSeconds,
          entry.clientInfo,
          entry.timestampCreated,
          entry.timestampLastUpdated,
          entry.capturedAt,
          entry.sourceHost,
          entry.sourcePort,
        );
      }
    });

    insertMany(entries);
    return entries.length;
  }

  async getAclEntries(options: AuditQueryOptions = {}): Promise<StoredAclEntry[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.username) {
      conditions.push('username = ?');
      params.push(options.username);
    }

    if (options.reason) {
      conditions.push('reason = ?');
      params.push(options.reason);
    }

    if (options.startTime) {
      conditions.push('captured_at >= ?');
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push('captured_at <= ?');
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM acl_audit
      ${whereClause}
      ORDER BY captured_at DESC, id DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: number;
      count: number;
      reason: string;
      context: string;
      object: string;
      username: string;
      age_seconds: number;
      client_info: string;
      timestamp_created: number;
      timestamp_last_updated: number;
      captured_at: number;
      source_host: string;
      source_port: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      count: row.count,
      reason: row.reason,
      context: row.context,
      object: row.object,
      username: row.username,
      ageSeconds: row.age_seconds,
      clientInfo: row.client_info,
      timestampCreated: row.timestamp_created,
      timestampLastUpdated: row.timestamp_last_updated,
      capturedAt: row.captured_at,
      sourceHost: row.source_host,
      sourcePort: row.source_port,
    }));
  }

  async getAuditStats(startTime?: number, endTime?: number): Promise<AuditStats> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: number[] = [];

    if (startTime) {
      conditions.push('captured_at >= ?');
      params.push(startTime);
    }

    if (endTime) {
      conditions.push('captured_at <= ?');
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Total entries
    const totalResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM acl_audit ${whereClause}`)
      .get(...params) as { count: number };

    // Unique users
    const uniqueUsersResult = this.db
      .prepare(`SELECT COUNT(DISTINCT username) as count FROM acl_audit ${whereClause}`)
      .get(...params) as { count: number };

    // Entries by reason
    const byReasonRows = this.db
      .prepare(`SELECT reason, COUNT(*) as count FROM acl_audit ${whereClause} GROUP BY reason`)
      .all(...params) as Array<{ reason: string; count: number }>;

    const entriesByReason: Record<string, number> = {};
    for (const row of byReasonRows) {
      entriesByReason[row.reason] = row.count;
    }

    // Entries by user
    const byUserRows = this.db
      .prepare(`SELECT username, COUNT(*) as count FROM acl_audit ${whereClause} GROUP BY username`)
      .all(...params) as Array<{ username: string; count: number }>;

    const entriesByUser: Record<string, number> = {};
    for (const row of byUserRows) {
      entriesByUser[row.username] = row.count;
    }

    // Time range
    const timeRangeResult = this.db
      .prepare(`SELECT MIN(captured_at) as earliest, MAX(captured_at) as latest FROM acl_audit ${whereClause}`)
      .get(...params) as { earliest: number | null; latest: number | null };

    const timeRange =
      timeRangeResult.earliest !== null && timeRangeResult.latest !== null
        ? { earliest: timeRangeResult.earliest, latest: timeRangeResult.latest }
        : null;

    return {
      totalEntries: totalResult.count,
      uniqueUsers: uniqueUsersResult.count,
      entriesByReason,
      entriesByUser,
      timeRange,
    };
  }

  async pruneOldEntries(olderThanTimestamp: number): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.prepare('DELETE FROM acl_audit WHERE captured_at < ?').run(olderThanTimestamp);

    return result.changes;
  }

  private createSchema(): void {
    if (!this.db) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS acl_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count INTEGER NOT NULL,
        reason TEXT NOT NULL,
        context TEXT NOT NULL,
        object TEXT NOT NULL,
        username TEXT NOT NULL,
        age_seconds INTEGER NOT NULL,
        client_info TEXT NOT NULL,
        timestamp_created INTEGER NOT NULL,
        timestamp_last_updated INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(timestamp_created, username, object, reason, source_host, source_port)
      );

      CREATE INDEX IF NOT EXISTS idx_acl_username ON acl_audit(username);
      CREATE INDEX IF NOT EXISTS idx_acl_reason ON acl_audit(reason);
      CREATE INDEX IF NOT EXISTS idx_acl_captured_at ON acl_audit(captured_at);
      CREATE INDEX IF NOT EXISTS idx_acl_timestamp_created ON acl_audit(timestamp_created);
    `);
  }
}
