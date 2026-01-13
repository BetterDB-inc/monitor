import { Pool, PoolClient } from 'pg';
import {
  StoragePort,
  StoredAclEntry,
  AuditQueryOptions,
  AuditStats,
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
} from '../../common/interfaces/storage-port.interface';

export interface PostgresAdapterConfig {
  connectionString: string;
}

export class PostgresAdapter implements StoragePort {
  private pool: Pool | null = null;
  private ready: boolean = false;

  constructor(private config: PostgresAdapterConfig) {}

  async initialize(): Promise<void> {
    try {
      this.pool = new Pool({
        connectionString: this.config.connectionString,
      });

      // Test connection
      const client = await this.pool.connect();
      client.release();

      // Create schema
      await this.createSchema();
      this.ready = true;
    } catch (error) {
      this.ready = false;
      throw new Error(
        `Failed to initialize PostgreSQL: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready && this.pool !== null;
  }

  async saveAclEntries(entries: StoredAclEntry[]): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (entries.length === 0) {
      return 0;
    }

    const values: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const entry of entries) {
      values.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11})`,
      );
      params.push(
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
      paramIndex += 12;
    }

    const query = `
      INSERT INTO acl_audit (
        count, reason, context, object, username, age_seconds, client_info,
        timestamp_created, timestamp_last_updated, captured_at, source_host, source_port
      ) VALUES ${values.join(', ')}
      ON CONFLICT (timestamp_created, username, object, reason, source_host, source_port)
      DO UPDATE SET
        count = EXCLUDED.count,
        age_seconds = EXCLUDED.age_seconds,
        timestamp_last_updated = EXCLUDED.timestamp_last_updated,
        captured_at = EXCLUDED.captured_at
    `;

    await this.pool.query(query, params);
    return entries.length;
  }

  async getAclEntries(options: AuditQueryOptions = {}): Promise<StoredAclEntry[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (options.username) {
      conditions.push(`username = $${paramIndex++}`);
      params.push(options.username);
    }

    if (options.reason) {
      conditions.push(`reason = $${paramIndex++}`);
      params.push(options.reason);
    }

    if (options.startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM acl_audit
      ${whereClause}
      ORDER BY captured_at DESC, id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map((row) => ({
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
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: number[] = [];
    let paramIndex = 1;

    if (startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(startTime);
    }

    if (endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM acl_audit ${whereClause}`,
      params,
    );

    const uniqueUsersResult = await this.pool.query(
      `SELECT COUNT(DISTINCT username) as count FROM acl_audit ${whereClause}`,
      params,
    );

    const byReasonResult = await this.pool.query(
      `SELECT reason, COUNT(*) as count FROM acl_audit ${whereClause} GROUP BY reason`,
      params,
    );

    const byUserResult = await this.pool.query(
      `SELECT username, COUNT(*) as count FROM acl_audit ${whereClause} GROUP BY username`,
      params,
    );

    const timeRangeResult = await this.pool.query(
      `SELECT MIN(captured_at) as earliest, MAX(captured_at) as latest FROM acl_audit ${whereClause}`,
      params,
    );

    const entriesByReason: Record<string, number> = {};
    for (const row of byReasonResult.rows) {
      entriesByReason[row.reason] = parseInt(row.count);
    }

    const entriesByUser: Record<string, number> = {};
    for (const row of byUserResult.rows) {
      entriesByUser[row.username] = parseInt(row.count);
    }

    const timeRange =
      timeRangeResult.rows[0].earliest !== null && timeRangeResult.rows[0].latest !== null
        ? {
            earliest: parseInt(timeRangeResult.rows[0].earliest),
            latest: parseInt(timeRangeResult.rows[0].latest),
          }
        : null;

    return {
      totalEntries: parseInt(totalResult.rows[0].count),
      uniqueUsers: parseInt(uniqueUsersResult.rows[0].count),
      entriesByReason,
      entriesByUser,
      timeRange,
    };
  }

  async pruneOldEntries(olderThanTimestamp: number): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const result = await this.pool.query('DELETE FROM acl_audit WHERE captured_at < $1', [
      olderThanTimestamp,
    ]);

    return result.rowCount || 0;
  }

  async saveClientSnapshot(clients: StoredClientSnapshot[]): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (clients.length === 0) {
      return 0;
    }

    const values: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const client of clients) {
      values.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11}, $${paramIndex + 12}, $${paramIndex + 13}, $${paramIndex + 14}, $${paramIndex + 15}, $${paramIndex + 16}, $${paramIndex + 17}, $${paramIndex + 18})`,
      );
      params.push(
        client.clientId,
        client.addr,
        client.name || null,
        client.user || null,
        client.db,
        client.cmd || null,
        client.age,
        client.idle,
        client.flags || null,
        client.sub,
        client.psub,
        client.qbuf,
        client.qbufFree,
        client.obl,
        client.oll,
        client.omem,
        client.capturedAt,
        client.sourceHost,
        client.sourcePort,
      );
      paramIndex += 19;
    }

    const query = `
      INSERT INTO client_snapshots (
        client_id, addr, name, user_name, db, cmd, age, idle, flags,
        sub, psub, qbuf, qbuf_free, obl, oll, omem,
        captured_at, source_host, source_port
      ) VALUES ${values.join(', ')}
    `;

    await this.pool.query(query, params);
    return clients.length;
  }

  async getClientSnapshots(options: ClientSnapshotQueryOptions = {}): Promise<StoredClientSnapshot[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (options.clientName) {
      conditions.push(`name = $${paramIndex++}`);
      params.push(options.clientName);
    }

    if (options.user) {
      conditions.push(`user_name = $${paramIndex++}`);
      params.push(options.user);
    }

    if (options.addr) {
      if (options.addr.includes('%')) {
        conditions.push(`addr LIKE $${paramIndex++}`);
      } else {
        conditions.push(`addr = $${paramIndex++}`);
      }
      params.push(options.addr);
    }

    if (options.startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const query = `
      SELECT * FROM client_snapshots
      ${whereClause}
      ORDER BY captured_at DESC, id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map(this.mapClientRow);
  }

  async getClientTimeSeries(
    startTime: number,
    endTime: number,
    bucketSizeMs: number = 60000,
  ): Promise<ClientTimeSeriesPoint[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const query = `
      SELECT
        (captured_at / $1 * $1) as bucket_time,
        COUNT(*) as total_connections,
        name,
        user_name,
        addr
      FROM client_snapshots
      WHERE captured_at >= $2 AND captured_at <= $3
      GROUP BY bucket_time, name, user_name, addr
      ORDER BY bucket_time
    `;

    const result = await this.pool.query(query, [bucketSizeMs, startTime, endTime]);

    const pointsMap = new Map<number, ClientTimeSeriesPoint>();

    for (const row of result.rows) {
      const bucketTime = parseInt(row.bucket_time);
      if (!pointsMap.has(bucketTime)) {
        pointsMap.set(bucketTime, {
          timestamp: bucketTime,
          totalConnections: 0,
          byName: {},
          byUser: {},
          byAddr: {},
        });
      }

      const point = pointsMap.get(bucketTime)!;
      point.totalConnections += parseInt(row.total_connections);

      if (row.name) {
        point.byName[row.name] = (point.byName[row.name] || 0) + 1;
      }
      if (row.user_name) {
        point.byUser[row.user_name] = (point.byUser[row.user_name] || 0) + 1;
      }
      const ip = row.addr.split(':')[0];
      point.byAddr[ip] = (point.byAddr[ip] || 0) + 1;
    }

    return Array.from(pointsMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  async getClientAnalyticsStats(startTime?: number, endTime?: number): Promise<ClientAnalyticsStats> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: number[] = [];
    let paramIndex = 1;

    if (startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(startTime);
    }

    if (endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get latest timestamp
    const latestResult = await this.pool.query(
      `SELECT MAX(captured_at) as latest FROM client_snapshots ${whereClause}`,
      params,
    );
    const latestTimestamp = latestResult.rows[0].latest;

    const currentConditions = latestTimestamp ? [...conditions, `captured_at = $${paramIndex++}`] : conditions;
    const currentParams = latestTimestamp ? [...params, latestTimestamp] : params;
    const currentWhereClause = currentConditions.length > 0 ? `WHERE ${currentConditions.join(' AND ')}` : '';

    const currentConnectionsResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM client_snapshots ${currentWhereClause}`,
      currentParams,
    );

    const peakResult = await this.pool.query(
      `
      SELECT captured_at, COUNT(*) as count
      FROM client_snapshots ${whereClause}
      GROUP BY captured_at
      ORDER BY count DESC
      LIMIT 1
    `,
      params,
    );

    const uniqueStatsResult = await this.pool.query(
      `
      SELECT
        COUNT(DISTINCT name) as unique_names,
        COUNT(DISTINCT user_name) as unique_users,
        COUNT(DISTINCT SPLIT_PART(addr, ':', 1)) as unique_ips
      FROM client_snapshots ${whereClause}
    `,
      params,
    );

    // Connections by name
    const byNameResult = await this.pool.query(
      `
      SELECT name, COUNT(*) as total, AVG(age) as avg_age
      FROM client_snapshots ${whereClause}
      GROUP BY name
    `,
      params,
    );

    const connectionsByName: Record<string, { current: number; peak: number; avgAge: number }> = {};

    for (const row of byNameResult.rows) {
      if (row.name) {
        const namePeakResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE name = $${currentParams.length + 1} ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
          GROUP BY captured_at
          ORDER BY count DESC
          LIMIT 1
        `,
          [...params, row.name],
        );

        const nameCurrentResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE name = $${currentParams.length + 1} ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
        `,
          [...currentParams, row.name],
        );

        connectionsByName[row.name] = {
          current: parseInt(nameCurrentResult.rows[0]?.count || '0'),
          peak: parseInt(namePeakResult.rows[0]?.count || '0'),
          avgAge: parseFloat(row.avg_age),
        };
      }
    }

    // Connections by user
    const byUserResult = await this.pool.query(
      `SELECT user_name, COUNT(*) as total FROM client_snapshots ${whereClause} GROUP BY user_name`,
      params,
    );

    const connectionsByUser: Record<string, { current: number; peak: number }> = {};

    for (const row of byUserResult.rows) {
      if (row.user_name) {
        const userPeakResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE user_name = $${currentParams.length + 1} ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
          GROUP BY captured_at
          ORDER BY count DESC
          LIMIT 1
        `,
          [...params, row.user_name],
        );

        const userCurrentResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE user_name = $${currentParams.length + 1} ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
        `,
          [...currentParams, row.user_name],
        );

        connectionsByUser[row.user_name] = {
          current: parseInt(userCurrentResult.rows[0]?.count || '0'),
          peak: parseInt(userPeakResult.rows[0]?.count || '0'),
        };
      }
    }

    // Connections by user and name
    const byUserAndNameResult = await this.pool.query(
      `
      SELECT user_name, name, COUNT(*) as total, AVG(age) as avg_age
      FROM client_snapshots ${whereClause}
      GROUP BY user_name, name
    `,
      params,
    );

    const connectionsByUserAndName: Record<string, { user: string; name: string; current: number; peak: number; avgAge: number }> = {};

    for (const row of byUserAndNameResult.rows) {
      const key = `${row.user_name}:${row.name}`;

      const combinedPeakResult = await this.pool.query(
        `
        SELECT COUNT(*) as count
        FROM client_snapshots
        WHERE user_name = $${currentParams.length + 1} AND name = $${currentParams.length + 2} ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
        GROUP BY captured_at
        ORDER BY count DESC
        LIMIT 1
      `,
        [...params, row.user_name, row.name],
      );

      const combinedCurrentResult = await this.pool.query(
        `
        SELECT COUNT(*) as count
        FROM client_snapshots
        WHERE user_name = $${currentParams.length + 1} AND name = $${currentParams.length + 2} ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
      `,
        [...currentParams, row.user_name, row.name],
      );

      connectionsByUserAndName[key] = {
        user: row.user_name,
        name: row.name,
        current: parseInt(combinedCurrentResult.rows[0]?.count || '0'),
        peak: parseInt(combinedPeakResult.rows[0]?.count || '0'),
        avgAge: parseFloat(row.avg_age),
      };
    }

    const timeRangeResult = await this.pool.query(
      `SELECT MIN(captured_at) as earliest, MAX(captured_at) as latest FROM client_snapshots ${whereClause}`,
      params,
    );

    const timeRange =
      timeRangeResult.rows[0].earliest !== null && timeRangeResult.rows[0].latest !== null
        ? {
            earliest: parseInt(timeRangeResult.rows[0].earliest),
            latest: parseInt(timeRangeResult.rows[0].latest),
          }
        : null;

    return {
      currentConnections: parseInt(currentConnectionsResult.rows[0].count),
      peakConnections: parseInt(peakResult.rows[0]?.count || '0'),
      peakTimestamp: parseInt(peakResult.rows[0]?.captured_at || '0'),
      uniqueClientNames: parseInt(uniqueStatsResult.rows[0].unique_names),
      uniqueUsers: parseInt(uniqueStatsResult.rows[0].unique_users),
      uniqueIps: parseInt(uniqueStatsResult.rows[0].unique_ips),
      connectionsByName,
      connectionsByUser,
      connectionsByUserAndName,
      timeRange,
    };
  }

  async getClientConnectionHistory(
    identifier: { name?: string; user?: string; addr?: string },
    startTime?: number,
    endTime?: number,
  ): Promise<StoredClientSnapshot[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (identifier.name) {
      conditions.push(`name = $${paramIndex++}`);
      params.push(identifier.name);
    }

    if (identifier.user) {
      conditions.push(`user_name = $${paramIndex++}`);
      params.push(identifier.user);
    }

    if (identifier.addr) {
      conditions.push(`addr = $${paramIndex++}`);
      params.push(identifier.addr);
    }

    if (startTime) {
      conditions.push(`captured_at >= $${paramIndex++}`);
      params.push(startTime);
    }

    if (endTime) {
      conditions.push(`captured_at <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT * FROM client_snapshots
      ${whereClause}
      ORDER BY captured_at ASC
    `;

    const result = await this.pool.query(query, params);
    return result.rows.map(this.mapClientRow);
  }

  async pruneOldClientSnapshots(olderThanTimestamp: number): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const result = await this.pool.query('DELETE FROM client_snapshots WHERE captured_at < $1', [
      olderThanTimestamp,
    ]);

    return result.rowCount || 0;
  }

  private mapClientRow(row: any): StoredClientSnapshot {
    return {
      id: row.id,
      clientId: row.client_id,
      addr: row.addr,
      name: row.name,
      user: row.user_name,
      db: row.db,
      cmd: row.cmd,
      age: row.age,
      idle: row.idle,
      flags: row.flags,
      sub: row.sub,
      psub: row.psub,
      qbuf: row.qbuf,
      qbufFree: row.qbuf_free,
      obl: row.obl,
      oll: row.oll,
      omem: row.omem,
      capturedAt: row.captured_at,
      sourceHost: row.source_host,
      sourcePort: row.source_port,
    };
  }

  private async createSchema(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS acl_audit (
        id SERIAL PRIMARY KEY,
        count INTEGER NOT NULL,
        reason TEXT NOT NULL,
        context TEXT NOT NULL,
        object TEXT NOT NULL,
        username TEXT NOT NULL,
        age_seconds DOUBLE PRECISION NOT NULL,
        client_info TEXT NOT NULL,
        timestamp_created BIGINT NOT NULL,
        timestamp_last_updated BIGINT NOT NULL,
        captured_at BIGINT NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(timestamp_created, username, object, reason, source_host, source_port)
      );

      CREATE INDEX IF NOT EXISTS idx_acl_username ON acl_audit(username);
      CREATE INDEX IF NOT EXISTS idx_acl_reason ON acl_audit(reason);
      CREATE INDEX IF NOT EXISTS idx_acl_captured_at ON acl_audit(captured_at);
      CREATE INDEX IF NOT EXISTS idx_acl_timestamp_created ON acl_audit(timestamp_created);

      CREATE TABLE IF NOT EXISTS client_snapshots (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        addr TEXT NOT NULL,
        name TEXT,
        user_name TEXT,
        db INTEGER NOT NULL,
        cmd TEXT,
        age INTEGER NOT NULL,
        idle INTEGER NOT NULL,
        flags TEXT,
        sub INTEGER NOT NULL DEFAULT 0,
        psub INTEGER NOT NULL DEFAULT 0,
        qbuf INTEGER NOT NULL DEFAULT 0,
        qbuf_free INTEGER NOT NULL DEFAULT 0,
        obl INTEGER NOT NULL DEFAULT 0,
        oll INTEGER NOT NULL DEFAULT 0,
        omem INTEGER NOT NULL DEFAULT 0,
        captured_at BIGINT NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_client_captured_at ON client_snapshots(captured_at);
      CREATE INDEX IF NOT EXISTS idx_client_name ON client_snapshots(name);
      CREATE INDEX IF NOT EXISTS idx_client_user ON client_snapshots(user_name);
      CREATE INDEX IF NOT EXISTS idx_client_addr ON client_snapshots(addr);
      CREATE INDEX IF NOT EXISTS idx_client_idle ON client_snapshots(idle) WHERE idle > 300;
      CREATE INDEX IF NOT EXISTS idx_client_qbuf ON client_snapshots(qbuf) WHERE qbuf > 1000000;
      CREATE INDEX IF NOT EXISTS idx_client_omem ON client_snapshots(omem) WHERE omem > 10000000;
      CREATE INDEX IF NOT EXISTS idx_client_cmd ON client_snapshots(cmd);
      CREATE INDEX IF NOT EXISTS idx_client_captured_at_cmd ON client_snapshots(captured_at, cmd);
    `);
  }
}
