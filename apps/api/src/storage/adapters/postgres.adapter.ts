import { Pool, PoolClient, PoolConfig } from 'pg';
import {
  StoragePort,
  StoredAclEntry,
  AuditQueryOptions,
  AuditStats,
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
  StoredAnomalyEvent,
  StoredCorrelatedGroup,
  AnomalyQueryOptions,
  AnomalyStats,
  KeyPatternSnapshot,
  KeyPatternQueryOptions,
  KeyAnalyticsSummary,
  AppSettings,
  SettingsUpdateRequest,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  DeliveryStatus,
  StoredSlowLogEntry,
  SlowLogQueryOptions,
  StoredCommandLogEntry,
  CommandLogQueryOptions,
  CommandLogType,
} from '../../common/interfaces/storage-port.interface';
import { PostgresDialect, RowMappers } from './base-sql.adapter';

export interface PostgresAdapterConfig {
  connectionString: string;
}

export class PostgresAdapter implements StoragePort {
  private pool: Pool | null = null;
  private ready: boolean = false;
  private readonly mappers = new RowMappers(PostgresDialect);

  constructor(private config: PostgresAdapterConfig) { }

  async initialize(): Promise<void> {
    try {
      // Issue #11: Properly type poolConfig instead of using 'any'
      const poolConfig: PoolConfig = {
        connectionString: this.config.connectionString,
      };

      // Enable SSL if STORAGE_SSL_CA is set (URL or file path)
      const sslCa = process.env.STORAGE_SSL_CA;

      if (sslCa) {
        let ca: string;

        // Issue #3: Add security validation for SSL CA URLs
        // Only allow HTTPS to prevent man-in-the-middle attacks on CA certificate fetching
        if (sslCa.startsWith('http://')) {
          throw new Error(
            'Fetching SSL CA certificate over insecure HTTP is not allowed. ' +
            'Use HTTPS or provide a local file path instead.'
          );
        }

        if (sslCa.startsWith('https://')) {
          // Whitelist of trusted domains for SSL certificates
          const trustedDomains = [
            'truststore.pki.rds.amazonaws.com',
            's3.amazonaws.com',
            'storage.googleapis.com',
            'azure.microsoft.com',
          ];

          const url = new URL(sslCa);

          // Check domain with proper boundary to prevent subdomain spoofing
          // e.g., evil-s3.amazonaws.com should NOT match s3.amazonaws.com
          const isTrustedDomain = trustedDomains.some(domain => {
            return url.hostname === domain || url.hostname.endsWith('.' + domain);
          });

          if (!isTrustedDomain) {
            console.warn(
              `Warning: Fetching SSL certificate from untrusted domain: ${url.hostname}. ` +
              `Trusted domains: ${trustedDomains.join(', ')}`
            );
          }

          // Issue #8: Add telemetry/logging for SSL operations
          console.log(`Fetching SSL CA bundle from: ${sslCa}`);

          try {
            // Add timeout to fetch
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

            const response = await fetch(sslCa, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
              throw new Error(`Failed to fetch CA bundle from ${sslCa}: ${response.status}`);
            }
            ca = await response.text();
            console.log('Successfully fetched SSL CA bundle');
          } catch (fetchError) {
            // Issue #8: Log SSL errors for debugging
            const errorMsg = fetchError instanceof Error ? fetchError.message : 'Unknown error';
            console.error(`Failed to fetch SSL CA bundle: ${errorMsg}`);
            throw new Error(`Failed to fetch SSL CA bundle from ${sslCa}: ${errorMsg}`);
          }
        } else {
          // Read from file path
          console.log(`Reading SSL CA bundle from file: ${sslCa}`);
          const fs = await import('fs');
          try {
            ca = fs.readFileSync(sslCa, 'utf8');
            console.log('Successfully loaded SSL CA bundle from file');
          } catch (fileError) {
            const errorMsg = fileError instanceof Error ? fileError.message : 'Unknown error';
            console.error(`Failed to read SSL CA file: ${errorMsg}`);
            throw new Error(`Failed to read SSL CA file ${sslCa}: ${errorMsg}`);
          }
        }

        poolConfig.ssl = {
          rejectUnauthorized: true,
          ca,
        };
      }

      this.pool = new Pool(poolConfig);

      // Test connection
      const client = await this.pool.connect();
      client.release();

      // Issue #9: Restore explanatory comments for migration order
      // Run migrations FIRST to add connection_id to existing tables.
      // This must happen before createSchema() which creates indexes on connection_id.
      await this.migrateConnectionId();
      await this.createSchema();

      this.ready = true;
    } catch (error) {
      this.ready = false;
      throw new Error(
        `Failed to initialize PostgreSQL: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Add connection_id column to all data tables for multi-database support.
   * This migration is idempotent and safe to run multiple times.
   */
  private async migrateConnectionId(): Promise<void> {
    if (!this.pool) return;

    const tables = [
      'acl_audit',
      'client_snapshots',
      'anomaly_events',
      'correlated_anomaly_groups',
      'key_pattern_snapshots',
      'webhooks',
      'webhook_deliveries',
      'slow_log_entries',
      'command_log_entries',
    ];

    for (const table of tables) {
      try {
        // Add connection_id column if it doesn't exist
        await this.pool.query(`
          ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS connection_id TEXT DEFAULT 'env-default'
        `);

        // Create index on connection_id
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS idx_${table}_connection_id
          ON ${table}(connection_id)
        `);
      } catch (error) {
        // Ignore errors - column/index might already exist in older PG versions
      }
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

  async saveAclEntries(entries: StoredAclEntry[], connectionId: string): Promise<number> {
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
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11}, $${paramIndex + 12})`,
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
        connectionId,
      );
      paramIndex += 13;
    }

    const query = `
      INSERT INTO acl_audit (
        count, reason, context, object, username, age_seconds, client_info,
        timestamp_created, timestamp_last_updated, captured_at, source_host, source_port, connection_id
      ) VALUES ${values.join(', ')}
      ON CONFLICT (timestamp_created, username, object, reason, source_host, source_port, connection_id)
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

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }

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
    return result.rows.map((row) => this.mappers.mapAclEntryRow(row));
  }

  async getAuditStats(startTime?: number, endTime?: number, connectionId?: string): Promise<AuditStats> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (number | string)[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
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

  async pruneOldEntries(olderThanTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM acl_audit WHERE captured_at < $1 AND connection_id = $2',
        [olderThanTimestamp, connectionId]
      );
      return result.rowCount || 0;
    }

    const result = await this.pool.query('DELETE FROM acl_audit WHERE captured_at < $1', [
      olderThanTimestamp,
    ]);

    return result.rowCount || 0;
  }

  async saveClientSnapshot(clients: StoredClientSnapshot[], connectionId: string): Promise<number> {
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
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11}, $${paramIndex + 12}, $${paramIndex + 13}, $${paramIndex + 14}, $${paramIndex + 15}, $${paramIndex + 16}, $${paramIndex + 17}, $${paramIndex + 18}, $${paramIndex + 19})`,
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
        connectionId,
      );
      paramIndex += 20;
    }

    const query = `
      INSERT INTO client_snapshots (
        client_id, addr, name, user_name, db, cmd, age, idle, flags,
        sub, psub, qbuf, qbuf_free, obl, oll, omem,
        captured_at, source_host, source_port, connection_id
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

    if (options.connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(options.connectionId);
    }

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
    return result.rows.map((row) => this.mappers.mapClientRow(row));
  }

  async getClientTimeSeries(
    startTime: number,
    endTime: number,
    bucketSizeMs: number = 60000,
    connectionId?: string,
  ): Promise<ClientTimeSeriesPoint[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions = ['captured_at >= $2', 'captured_at <= $3'];
    const params: any[] = [bucketSizeMs, startTime, endTime];

    if (connectionId) {
      conditions.push(`connection_id = $4`);
      params.push(connectionId);
    }

    const query = `
      SELECT
        (captured_at / $1 * $1) as bucket_time,
        COUNT(*) as total_connections,
        name,
        user_name,
        addr
      FROM client_snapshots
      WHERE ${conditions.join(' AND ')}
      GROUP BY bucket_time, name, user_name, addr
      ORDER BY bucket_time
    `;

    const result = await this.pool.query(query, params);

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

  async getClientAnalyticsStats(startTime?: number, endTime?: number, connectionId?: string): Promise<ClientAnalyticsStats> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (number | string)[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
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
        const namePeakParams = [...params, row.name];
        const namePeakResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE name = $${params.length + 1} ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
          GROUP BY captured_at
          ORDER BY count DESC
          LIMIT 1
        `,
          namePeakParams,
        );

        const nameCurrentParams = [...currentParams, row.name];
        const nameCurrentResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE name = $${currentParams.length + 1} ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
        `,
          nameCurrentParams,
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
        const userPeakParams = [...params, row.user_name];
        const userPeakResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE user_name = $${params.length + 1} ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
          GROUP BY captured_at
          ORDER BY count DESC
          LIMIT 1
        `,
          userPeakParams,
        );

        const userCurrentParams = [...currentParams, row.user_name];
        const userCurrentResult = await this.pool.query(
          `
          SELECT COUNT(*) as count
          FROM client_snapshots
          WHERE user_name = $${currentParams.length + 1} ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
        `,
          userCurrentParams,
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

      const combinedPeakParams = [...params, row.user_name, row.name];
      const combinedPeakResult = await this.pool.query(
        `
        SELECT COUNT(*) as count
        FROM client_snapshots
        WHERE user_name = $${params.length + 1} AND name = $${params.length + 2} ${whereClause ? 'AND ' + whereClause.substring(6) : ''}
        GROUP BY captured_at
        ORDER BY count DESC
        LIMIT 1
      `,
        combinedPeakParams,
      );

      const combinedCurrentParams = [...currentParams, row.user_name, row.name];
      const combinedCurrentResult = await this.pool.query(
        `
        SELECT COUNT(*) as count
        FROM client_snapshots
        WHERE user_name = $${currentParams.length + 1} AND name = $${currentParams.length + 2} ${currentWhereClause ? 'AND ' + currentWhereClause.substring(6) : ''}
      `,
        combinedCurrentParams,
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
    connectionId?: string,
  ): Promise<StoredClientSnapshot[]> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
    }

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
    return result.rows.map((row) => this.mappers.mapClientRow(row));
  }

  async pruneOldClientSnapshots(olderThanTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM client_snapshots WHERE captured_at < $1 AND connection_id = $2',
        [olderThanTimestamp, connectionId]
      );
      return result.rowCount || 0;
    }

    const result = await this.pool.query('DELETE FROM client_snapshots WHERE captured_at < $1', [
      olderThanTimestamp,
    ]);

    return result.rowCount || 0;
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
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(timestamp_created, username, object, reason, source_host, source_port, connection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_acl_username ON acl_audit(username);
      CREATE INDEX IF NOT EXISTS idx_acl_reason ON acl_audit(reason);
      CREATE INDEX IF NOT EXISTS idx_acl_captured_at ON acl_audit(captured_at);
      CREATE INDEX IF NOT EXISTS idx_acl_timestamp_created ON acl_audit(timestamp_created);
      CREATE INDEX IF NOT EXISTS idx_acl_connection_id ON acl_audit(connection_id);

      -- Add unique constraint if missing (for tables created before this constraint was added)
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'acl_audit_timestamp_created_username_object_reason_source__key'
        ) THEN
          -- Remove duplicates first (keep the one with highest id)
          DELETE FROM acl_audit a USING acl_audit b
          WHERE a.id < b.id
            AND a.timestamp_created = b.timestamp_created
            AND a.username = b.username
            AND a.object = b.object
            AND a.reason = b.reason
            AND a.source_host = b.source_host
            AND a.source_port = b.source_port
            AND a.connection_id = b.connection_id;

          ALTER TABLE acl_audit
          ADD CONSTRAINT acl_audit_timestamp_created_username_object_reason_source__key
          UNIQUE (timestamp_created, username, object, reason, source_host, source_port, connection_id);
        END IF;
      EXCEPTION WHEN duplicate_object THEN
        -- Constraint already exists, ignore
      END $$;

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
        source_port INTEGER NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default'
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
      CREATE INDEX IF NOT EXISTS idx_client_connection_id ON client_snapshots(connection_id);

      -- Anomaly Events Table
      CREATE TABLE IF NOT EXISTS anomaly_events (
        id UUID PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        metric_type VARCHAR(50) NOT NULL,
        anomaly_type VARCHAR(20) NOT NULL,
        severity VARCHAR(20) NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        baseline DOUBLE PRECISION NOT NULL,
        std_dev DOUBLE PRECISION NOT NULL,
        z_score DOUBLE PRECISION NOT NULL,
        threshold DOUBLE PRECISION NOT NULL,
        message TEXT NOT NULL,
        correlation_id UUID,
        related_metrics TEXT[],
        resolved BOOLEAN DEFAULT FALSE,
        resolved_at BIGINT,
        duration_ms BIGINT,
        source_host VARCHAR(255),
        source_port INTEGER,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_anomaly_events_timestamp ON anomaly_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_severity ON anomaly_events(severity, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_metric ON anomaly_events(metric_type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_correlation ON anomaly_events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_unresolved ON anomaly_events(resolved, timestamp DESC) WHERE NOT resolved;
      CREATE INDEX IF NOT EXISTS idx_anomaly_events_connection_id ON anomaly_events(connection_id);

      -- Correlated Anomaly Groups Table
      CREATE TABLE IF NOT EXISTS correlated_anomaly_groups (
        correlation_id UUID PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        pattern VARCHAR(50) NOT NULL,
        severity VARCHAR(20) NOT NULL,
        diagnosis TEXT NOT NULL,
        recommendations TEXT[],
        anomaly_count INTEGER NOT NULL,
        metric_types TEXT[],
        source_host VARCHAR(255),
        source_port INTEGER,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_correlated_groups_timestamp ON correlated_anomaly_groups(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_correlated_groups_pattern ON correlated_anomaly_groups(pattern, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_correlated_groups_severity ON correlated_anomaly_groups(severity, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_correlated_groups_connection_id ON correlated_anomaly_groups(connection_id);

      CREATE TABLE IF NOT EXISTS key_pattern_snapshots (
        id UUID PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        pattern TEXT NOT NULL,
        key_count INTEGER NOT NULL,
        sampled_key_count INTEGER NOT NULL,
        keys_with_ttl INTEGER NOT NULL,
        keys_expiring_soon INTEGER NOT NULL,
        total_memory_bytes BIGINT NOT NULL,
        avg_memory_bytes INTEGER NOT NULL,
        max_memory_bytes INTEGER NOT NULL,
        avg_access_frequency DOUBLE PRECISION,
        hot_key_count INTEGER,
        cold_key_count INTEGER,
        avg_idle_time_seconds DOUBLE PRECISION,
        stale_key_count INTEGER,
        avg_ttl_seconds INTEGER,
        min_ttl_seconds INTEGER,
        max_ttl_seconds INTEGER,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_kps_timestamp ON key_pattern_snapshots(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_kps_pattern ON key_pattern_snapshots(pattern, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_kps_pattern_timestamp ON key_pattern_snapshots(pattern, timestamp);
      CREATE INDEX IF NOT EXISTS idx_kps_connection_id ON key_pattern_snapshots(connection_id);

      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        audit_poll_interval_ms INTEGER NOT NULL DEFAULT 60000,
        client_analytics_poll_interval_ms INTEGER NOT NULL DEFAULT 60000,
        anomaly_poll_interval_ms INTEGER NOT NULL DEFAULT 1000,
        anomaly_cache_ttl_ms INTEGER NOT NULL DEFAULT 3600000,
        anomaly_prometheus_interval_ms INTEGER NOT NULL DEFAULT 30000,
        updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        secret TEXT,
        enabled BOOLEAN DEFAULT true,
        events TEXT[] NOT NULL,
        headers JSONB DEFAULT '{}',
        retry_policy JSONB NOT NULL,
        delivery_config JSONB,
        alert_config JSONB,
        thresholds JSONB,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Add columns if they don't exist (for existing databases)
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS delivery_config JSONB;
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS alert_config JSONB;
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS thresholds JSONB;

      CREATE INDEX IF NOT EXISTS idx_webhooks_connection_id ON webhooks(connection_id);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        status_code INT,
        response_body TEXT,
        attempts INT DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        duration_ms INT
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(status, next_retry_at) WHERE status = 'retrying';
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_connection_id ON webhook_deliveries(connection_id);

      -- Slow Log Entries Table
      CREATE TABLE IF NOT EXISTS slow_log_entries (
        pk SERIAL PRIMARY KEY,
        slowlog_id BIGINT NOT NULL,
        timestamp BIGINT NOT NULL,
        duration BIGINT NOT NULL,
        command TEXT[] NOT NULL DEFAULT '{}',
        client_address TEXT,
        client_name TEXT,
        captured_at BIGINT NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        UNIQUE(slowlog_id, source_host, source_port, connection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_slowlog_timestamp ON slow_log_entries(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_slowlog_command ON slow_log_entries(command);
      CREATE INDEX IF NOT EXISTS idx_slowlog_duration ON slow_log_entries(duration DESC);
      CREATE INDEX IF NOT EXISTS idx_slowlog_client_name ON slow_log_entries(client_name);
      CREATE INDEX IF NOT EXISTS idx_slowlog_captured_at ON slow_log_entries(captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_slowlog_connection_id ON slow_log_entries(connection_id);

      -- Add unique constraint if missing (for tables created before this constraint was added)
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          WHERE t.relname = 'slow_log_entries'
            AND c.contype = 'u'
            AND c.conkey @> ARRAY(
              SELECT attnum FROM pg_attribute
              WHERE attrelid = t.oid AND attname IN ('slowlog_id', 'source_host', 'source_port', 'connection_id')
            )
        ) THEN
          -- Remove duplicates first (keep the one with highest pk)
          DELETE FROM slow_log_entries a USING slow_log_entries b
          WHERE a.pk < b.pk
            AND a.slowlog_id = b.slowlog_id
            AND a.source_host = b.source_host
            AND a.source_port = b.source_port
            AND a.connection_id = b.connection_id;

          ALTER TABLE slow_log_entries
          ADD CONSTRAINT slow_log_entries_slowlog_id_source_host_source_port_conn_key
          UNIQUE (slowlog_id, source_host, source_port, connection_id);
        END IF;
      EXCEPTION WHEN duplicate_object THEN
        -- Constraint already exists, ignore
      END $$;

      -- Command Log Entries Table (Valkey-specific)
      CREATE TABLE IF NOT EXISTS command_log_entries (
        pk SERIAL PRIMARY KEY,
        commandlog_id BIGINT NOT NULL,
        timestamp BIGINT NOT NULL,
        duration BIGINT NOT NULL,
        command TEXT[] NOT NULL DEFAULT '{}',
        client_address TEXT,
        client_name TEXT,
        log_type TEXT NOT NULL,
        captured_at BIGINT NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        UNIQUE(commandlog_id, log_type, source_host, source_port, connection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_commandlog_timestamp ON command_log_entries(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_commandlog_type ON command_log_entries(log_type);
      CREATE INDEX IF NOT EXISTS idx_commandlog_duration ON command_log_entries(duration DESC);
      CREATE INDEX IF NOT EXISTS idx_commandlog_client_name ON command_log_entries(client_name);
      CREATE INDEX IF NOT EXISTS idx_commandlog_captured_at ON command_log_entries(captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_commandlog_connection_id ON command_log_entries(connection_id);

      -- Add unique constraint if missing (for tables created before this constraint was added)
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          WHERE t.relname = 'command_log_entries'
            AND c.contype = 'u'
            AND c.conkey @> ARRAY(
              SELECT attnum FROM pg_attribute
              WHERE attrelid = t.oid AND attname IN ('commandlog_id', 'log_type', 'source_host', 'source_port', 'connection_id')
            )
        ) THEN
          -- Remove duplicates first (keep the one with highest pk)
          DELETE FROM command_log_entries a USING command_log_entries b
          WHERE a.pk < b.pk
            AND a.commandlog_id = b.commandlog_id
            AND a.log_type = b.log_type
            AND a.source_host = b.source_host
            AND a.source_port = b.source_port
            AND a.connection_id = b.connection_id;

          ALTER TABLE command_log_entries
          ADD CONSTRAINT command_log_entries_cmdlog_id_type_host_port_conn_key
          UNIQUE (commandlog_id, log_type, source_host, source_port, connection_id);
        END IF;
      EXCEPTION WHEN duplicate_object THEN
        -- Constraint already exists, ignore
      END $$;

      -- Database Connections Table (stores multi-database connection configs)
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT,
        password TEXT,
        password_encrypted BOOLEAN NOT NULL DEFAULT false,
        db_index INTEGER NOT NULL DEFAULT 0,
        tls BOOLEAN NOT NULL DEFAULT false,
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at BIGINT NOT NULL,
        updated_at BIGINT
      );

      -- Migration: add password_encrypted column if it doesn't exist
      ALTER TABLE connections ADD COLUMN IF NOT EXISTS password_encrypted BOOLEAN NOT NULL DEFAULT false;

      CREATE INDEX IF NOT EXISTS idx_connections_is_default ON connections(is_default);
    `);
  }

  async saveAnomalyEvent(event: StoredAnomalyEvent, connectionId: string): Promise<string> {
    if (!this.pool) throw new Error('Database not initialized');

    await this.pool.query(
      `INSERT INTO anomaly_events (
        id, timestamp, metric_type, anomaly_type, severity,
        value, baseline, std_dev, z_score, threshold,
        message, correlation_id, related_metrics,
        resolved, resolved_at, duration_ms,
        source_host, source_port, connection_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (id) DO UPDATE SET
        correlation_id = COALESCE(EXCLUDED.correlation_id, anomaly_events.correlation_id),
        related_metrics = COALESCE(EXCLUDED.related_metrics, anomaly_events.related_metrics),
        resolved = EXCLUDED.resolved,
        resolved_at = EXCLUDED.resolved_at,
        duration_ms = EXCLUDED.duration_ms`,
      [
        event.id,
        event.timestamp,
        event.metricType,
        event.anomalyType,
        event.severity,
        event.value,
        event.baseline,
        event.stdDev,
        event.zScore,
        event.threshold,
        event.message,
        event.correlationId || null,
        event.relatedMetrics || [],
        event.resolved,
        event.resolvedAt || null,
        event.durationMs || null,
        event.sourceHost || null,
        event.sourcePort || null,
        connectionId,
      ]
    );

    return event.id;
  }

  async saveAnomalyEvents(events: StoredAnomalyEvent[], connectionId: string): Promise<number> {
    if (!this.pool || events.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const event of events) {
      placeholders.push(`(
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}
      )`);
      values.push(
        event.id,
        event.timestamp,
        event.metricType,
        event.anomalyType,
        event.severity,
        event.value,
        event.baseline,
        event.stdDev,
        event.zScore,
        event.threshold,
        event.message,
        event.correlationId || null,
        event.relatedMetrics || [],
        event.resolved,
        event.resolvedAt || null,
        event.durationMs || null,
        event.sourceHost || null,
        event.sourcePort || null,
        connectionId,
      );
    }

    const result = await this.pool.query(
      `INSERT INTO anomaly_events (
        id, timestamp, metric_type, anomaly_type, severity,
        value, baseline, std_dev, z_score, threshold,
        message, correlation_id, related_metrics,
        resolved, resolved_at, duration_ms,
        source_host, source_port, connection_id
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        correlation_id = COALESCE(EXCLUDED.correlation_id, anomaly_events.correlation_id),
        related_metrics = COALESCE(EXCLUDED.related_metrics, anomaly_events.related_metrics),
        resolved = EXCLUDED.resolved,
        resolved_at = EXCLUDED.resolved_at,
        duration_ms = EXCLUDED.duration_ms`,
      values
    );

    return result.rowCount ?? 0;
  }

  async getAnomalyEvents(options: AnomalyQueryOptions = {}): Promise<StoredAnomalyEvent[]> {
    if (!this.pool) throw new Error('Database not initialized');

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
    if (options.severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(options.severity);
    }
    if (options.metricType) {
      conditions.push(`metric_type = $${paramIndex++}`);
      params.push(options.metricType);
    }
    if (options.resolved !== undefined) {
      conditions.push(`resolved = $${paramIndex++}`);
      params.push(options.resolved);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(
      `SELECT
        id, timestamp, metric_type, anomaly_type, severity,
        value, baseline, std_dev, z_score, threshold,
        message, correlation_id, related_metrics,
        resolved, resolved_at, duration_ms,
        source_host, source_port, connection_id
      FROM anomaly_events
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    return result.rows.map((row) => this.mappers.mapAnomalyEventRow(row));
  }

  async getAnomalyStats(startTime?: number, endTime?: number, connectionId?: string): Promise<AnomalyStats> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
    }
    if (startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(startTime);
    }
    if (endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM anomaly_events ${whereClause}`,
      params
    );

    const severityResult = await this.pool.query(
      `SELECT severity, COUNT(*) as count FROM anomaly_events ${whereClause} GROUP BY severity`,
      params
    );

    const metricResult = await this.pool.query(
      `SELECT metric_type, COUNT(*) as count FROM anomaly_events ${whereClause} GROUP BY metric_type`,
      params
    );

    const unresolvedConditions = [...conditions];
    if (unresolvedConditions.length > 0) {
      unresolvedConditions.push(`resolved = false`);
    }
    const unresolvedWhereClause = unresolvedConditions.length > 0
      ? `WHERE ${unresolvedConditions.join(' AND ')}`
      : 'WHERE resolved = false';

    const unresolvedResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM anomaly_events ${unresolvedWhereClause}`,
      params
    );

    const bySeverity: Record<string, number> = {};
    for (const row of severityResult.rows) {
      bySeverity[row.severity] = parseInt(row.count);
    }

    const byMetric: Record<string, number> = {};
    for (const row of metricResult.rows) {
      byMetric[row.metric_type] = parseInt(row.count);
    }

    return {
      totalEvents: parseInt(totalResult.rows[0].total),
      bySeverity,
      byMetric,
      byPattern: {},
      unresolvedCount: parseInt(unresolvedResult.rows[0].count),
    };
  }

  async resolveAnomaly(id: string, resolvedAt: number): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query(
      `UPDATE anomaly_events
       SET resolved = true, resolved_at = $2, duration_ms = $2 - timestamp
       WHERE id = $1 AND resolved = false`,
      [id, resolvedAt]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async pruneOldAnomalyEvents(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM anomaly_events WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId]
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM anomaly_events WHERE timestamp < $1',
      [cutoffTimestamp]
    );

    return result.rowCount ?? 0;
  }

  async saveCorrelatedGroup(group: StoredCorrelatedGroup, connectionId: string): Promise<string> {
    if (!this.pool) throw new Error('Database not initialized');

    await this.pool.query(
      `INSERT INTO correlated_anomaly_groups (
        correlation_id, timestamp, pattern, severity,
        diagnosis, recommendations, anomaly_count, metric_types,
        source_host, source_port, connection_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (correlation_id) DO UPDATE SET
        diagnosis = EXCLUDED.diagnosis,
        recommendations = EXCLUDED.recommendations,
        anomaly_count = EXCLUDED.anomaly_count`,
      [
        group.correlationId,
        group.timestamp,
        group.pattern,
        group.severity,
        group.diagnosis,
        group.recommendations,
        group.anomalyCount,
        group.metricTypes,
        group.sourceHost || null,
        group.sourcePort || null,
        connectionId,
      ]
    );

    return group.correlationId;
  }

  async getCorrelatedGroups(options: AnomalyQueryOptions = {}): Promise<StoredCorrelatedGroup[]> {
    if (!this.pool) throw new Error('Database not initialized');

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
    if (options.severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(options.severity);
    }
    if (options.pattern) {
      conditions.push(`pattern = $${paramIndex++}`);
      params.push(options.pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(
      `SELECT
        correlation_id, timestamp, pattern, severity,
        diagnosis, recommendations, anomaly_count, metric_types,
        source_host, source_port, connection_id
      FROM correlated_anomaly_groups
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    return result.rows.map((row) => this.mappers.mapCorrelatedGroupRow(row));
  }

  async pruneOldCorrelatedGroups(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM correlated_anomaly_groups WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId]
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM correlated_anomaly_groups WHERE timestamp < $1',
      [cutoffTimestamp]
    );

    return result.rowCount ?? 0;
  }

  async saveKeyPatternSnapshots(snapshots: KeyPatternSnapshot[], connectionId: string): Promise<number> {
    if (!this.pool || snapshots.length === 0) return 0;

    const values: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const snapshot of snapshots) {
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      params.push(
        snapshot.id,
        snapshot.timestamp,
        snapshot.pattern,
        snapshot.keyCount,
        snapshot.sampledKeyCount,
        snapshot.keysWithTtl,
        snapshot.keysExpiringSoon,
        snapshot.totalMemoryBytes,
        snapshot.avgMemoryBytes,
        snapshot.maxMemoryBytes,
        snapshot.avgAccessFrequency ?? null,
        snapshot.hotKeyCount ?? null,
        snapshot.coldKeyCount ?? null,
        snapshot.avgIdleTimeSeconds ?? null,
        snapshot.staleKeyCount ?? null,
        snapshot.avgTtlSeconds ?? null,
        snapshot.minTtlSeconds ?? null,
        snapshot.maxTtlSeconds ?? null,
        connectionId,
      );
    }

    await this.pool.query(`
      INSERT INTO key_pattern_snapshots (
        id, timestamp, pattern, key_count, sampled_key_count,
        keys_with_ttl, keys_expiring_soon, total_memory_bytes,
        avg_memory_bytes, max_memory_bytes, avg_access_frequency,
        hot_key_count, cold_key_count, avg_idle_time_seconds,
        stale_key_count, avg_ttl_seconds, min_ttl_seconds, max_ttl_seconds, connection_id
      ) VALUES ${values.join(', ')}
    `, params);

    return snapshots.length;
  }

  async getKeyPatternSnapshots(options: KeyPatternQueryOptions = {}): Promise<KeyPatternSnapshot[]> {
    if (!this.pool) throw new Error('Database not initialized');

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
    if (options.pattern) {
      conditions.push(`pattern = $${paramIndex++}`);
      params.push(options.pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const result = await this.pool.query(`
      SELECT * FROM key_pattern_snapshots
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, [...params, limit, offset]);

    return result.rows.map((row) => this.mappers.mapKeyPatternSnapshotRow(row));
  }

  async getKeyAnalyticsSummary(startTime?: number, endTime?: number, connectionId?: string): Promise<KeyAnalyticsSummary | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: (number | string)[] = [];
    let paramIndex = 1;

    if (connectionId) {
      conditions.push(`connection_id = $${paramIndex++}`);
      params.push(connectionId);
    }
    if (startTime) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(startTime);
    }
    if (endTime) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const latestSnapshotsResult = await this.pool.query(`
      SELECT pattern, MAX(timestamp) as latest_timestamp
      FROM key_pattern_snapshots
      ${whereClause}
      GROUP BY pattern
    `, params);

    if (latestSnapshotsResult.rows.length === 0) return null;

    const patternConditions = latestSnapshotsResult.rows.map(() => '(pattern = ? AND timestamp = ?)').join(' OR ');
    const patternParams: any[] = [];
    for (const row of latestSnapshotsResult.rows) {
      patternParams.push(row.pattern, row.latest_timestamp);
    }

    let pIdx = 1;
    const patternPlaceholders = latestSnapshotsResult.rows.map(() => `(pattern = $${pIdx++} AND timestamp = $${pIdx++})`).join(' OR ');

    const summaryResult = await this.pool.query(`
      SELECT
        COUNT(DISTINCT pattern) as total_patterns,
        SUM(key_count) as total_keys,
        SUM(total_memory_bytes) as total_memory_bytes,
        SUM(stale_key_count) as stale_key_count,
        SUM(hot_key_count) as hot_key_count,
        SUM(cold_key_count) as cold_key_count,
        SUM(keys_expiring_soon) as keys_expiring_soon
      FROM key_pattern_snapshots
      WHERE ${patternPlaceholders}
    `, patternParams);

    const summary = summaryResult.rows[0];

    const patternRowsResult = await this.pool.query(`
      SELECT pattern, key_count, total_memory_bytes, avg_memory_bytes, stale_key_count, hot_key_count, cold_key_count
      FROM key_pattern_snapshots
      WHERE ${patternPlaceholders}
    `, patternParams);

    const byPattern: Record<string, any> = {};
    for (const row of patternRowsResult.rows) {
      byPattern[row.pattern] = {
        keyCount: row.key_count,
        memoryBytes: parseInt(row.total_memory_bytes),
        avgMemoryBytes: row.avg_memory_bytes,
        staleCount: row.stale_key_count ?? 0,
        hotCount: row.hot_key_count ?? 0,
        coldCount: row.cold_key_count ?? 0,
      };
    }

    const timeRangeResult = await this.pool.query(`
      SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest
      FROM key_pattern_snapshots ${whereClause}
    `, params);

    const timeRange = timeRangeResult.rows[0].earliest !== null && timeRangeResult.rows[0].latest !== null
      ? { earliest: parseInt(timeRangeResult.rows[0].earliest), latest: parseInt(timeRangeResult.rows[0].latest) }
      : null;

    return {
      totalPatterns: parseInt(summary.total_patterns) || 0,
      totalKeys: parseInt(summary.total_keys) || 0,
      totalMemoryBytes: parseInt(summary.total_memory_bytes) || 0,
      staleKeyCount: parseInt(summary.stale_key_count) || 0,
      hotKeyCount: parseInt(summary.hot_key_count) || 0,
      coldKeyCount: parseInt(summary.cold_key_count) || 0,
      keysExpiringSoon: parseInt(summary.keys_expiring_soon) || 0,
      byPattern,
      timeRange,
    };
  }

  async getKeyPatternTrends(pattern: string, startTime: number, endTime: number, connectionId?: string): Promise<Array<{
    timestamp: number;
    keyCount: number;
    memoryBytes: number;
    staleCount: number;
  }>> {
    if (!this.pool) throw new Error('Database not initialized');

    const conditions = ['pattern = $1', 'timestamp >= $2', 'timestamp <= $3'];
    const params: any[] = [pattern, startTime, endTime];

    if (connectionId) {
      conditions.push('connection_id = $4');
      params.push(connectionId);
    }

    const result = await this.pool.query(`
      SELECT timestamp, key_count, total_memory_bytes, stale_key_count
      FROM key_pattern_snapshots
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp ASC
    `, params);

    return result.rows.map(row => ({
      timestamp: parseInt(row.timestamp),
      keyCount: row.key_count,
      memoryBytes: parseInt(row.total_memory_bytes),
      staleCount: row.stale_key_count ?? 0,
    }));
  }

  async pruneOldKeyPatternSnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM key_pattern_snapshots WHERE timestamp < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId]
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM key_pattern_snapshots WHERE timestamp < $1',
      [cutoffTimestamp]
    );

    return result.rowCount ?? 0;
  }

  async getSettings(): Promise<AppSettings | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query('SELECT * FROM app_settings WHERE id = 1');

    if (result.rows.length === 0) {
      return null;
    }

    return this.mappers.mapSettingsRow(result.rows[0]);
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    if (!this.pool) throw new Error('Database not initialized');

    const now = Date.now();
    await this.pool.query(
      `INSERT INTO app_settings (
        id, audit_poll_interval_ms, client_analytics_poll_interval_ms,
        anomaly_poll_interval_ms, anomaly_cache_ttl_ms, anomaly_prometheus_interval_ms,
        updated_at, created_at
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(id) DO UPDATE SET
        audit_poll_interval_ms = EXCLUDED.audit_poll_interval_ms,
        client_analytics_poll_interval_ms = EXCLUDED.client_analytics_poll_interval_ms,
        anomaly_poll_interval_ms = EXCLUDED.anomaly_poll_interval_ms,
        anomaly_cache_ttl_ms = EXCLUDED.anomaly_cache_ttl_ms,
        anomaly_prometheus_interval_ms = EXCLUDED.anomaly_prometheus_interval_ms,
        updated_at = EXCLUDED.updated_at`,
      [
        settings.auditPollIntervalMs,
        settings.clientAnalyticsPollIntervalMs,
        settings.anomalyPollIntervalMs,
        settings.anomalyCacheTtlMs,
        settings.anomalyPrometheusIntervalMs,
        now,
        settings.createdAt || now
      ]
    );

    const saved = await this.getSettings();
    if (!saved) {
      throw new Error('Failed to save settings');
    }
    return saved;
  }

  async updateSettings(updates: SettingsUpdateRequest): Promise<AppSettings> {
    if (!this.pool) throw new Error('Database not initialized');

    const current = await this.getSettings();
    if (!current) {
      throw new Error('Settings not found. Initialize settings first.');
    }

    const merged: AppSettings = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };

    return this.saveSettings(merged);
  }

  async createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query(
      `INSERT INTO webhooks (name, url, secret, enabled, events, headers, retry_policy, delivery_config, alert_config, thresholds, connection_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        webhook.name,
        webhook.url,
        webhook.secret,
        webhook.enabled,
        webhook.events,
        JSON.stringify(webhook.headers || {}),
        JSON.stringify(webhook.retryPolicy),
        webhook.deliveryConfig ? JSON.stringify(webhook.deliveryConfig) : null,
        webhook.alertConfig ? JSON.stringify(webhook.alertConfig) : null,
        webhook.thresholds ? JSON.stringify(webhook.thresholds) : null,
        webhook.connectionId || null,
      ]
    );

    return this.mappers.mapWebhookRow(result.rows[0]);
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query('SELECT * FROM webhooks WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;

    return this.mappers.mapWebhookRow(result.rows[0]);
  }

  async getWebhooksByInstance(connectionId?: string): Promise<Webhook[]> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'SELECT * FROM webhooks WHERE connection_id = $1 OR connection_id IS NULL ORDER BY created_at DESC',
        [connectionId]
      );
      return result.rows.map((row) => this.mappers.mapWebhookRow(row));
    }

    // No connectionId provided - only return global webhooks (not scoped to any connection)
    const result = await this.pool.query('SELECT * FROM webhooks WHERE connection_id IS NULL ORDER BY created_at DESC');
    return result.rows.map((row) => this.mappers.mapWebhookRow(row));
  }

  async getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      // Return webhooks scoped to this connection OR global webhooks (no connectionId)
      const result = await this.pool.query(
        'SELECT * FROM webhooks WHERE enabled = true AND $1 = ANY(events) AND (connection_id = $2 OR connection_id IS NULL)',
        [event, connectionId]
      );
      return result.rows.map((row) => this.mappers.mapWebhookRow(row));
    }

    // No connectionId provided - only return global webhooks (not scoped to any connection)
    const result = await this.pool.query(
      'SELECT * FROM webhooks WHERE enabled = true AND $1 = ANY(events) AND connection_id IS NULL',
      [event]
    );

    return result.rows.map((row) => this.mappers.mapWebhookRow(row));
  }

  async updateWebhook(id: string, updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Webhook | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.url !== undefined) {
      setClauses.push(`url = $${paramIndex++}`);
      params.push(updates.url);
    }
    if (updates.secret !== undefined) {
      setClauses.push(`secret = $${paramIndex++}`);
      params.push(updates.secret);
    }
    if (updates.enabled !== undefined) {
      setClauses.push(`enabled = $${paramIndex++}`);
      params.push(updates.enabled);
    }
    if (updates.events !== undefined) {
      setClauses.push(`events = $${paramIndex++}`);
      params.push(updates.events);
    }
    if (updates.headers !== undefined) {
      setClauses.push(`headers = $${paramIndex++}`);
      params.push(JSON.stringify(updates.headers));
    }
    if (updates.retryPolicy !== undefined) {
      setClauses.push(`retry_policy = $${paramIndex++}`);
      params.push(JSON.stringify(updates.retryPolicy));
    }
    if (updates.deliveryConfig !== undefined) {
      setClauses.push(`delivery_config = $${paramIndex++}`);
      params.push(JSON.stringify(updates.deliveryConfig));
    }
    if (updates.alertConfig !== undefined) {
      setClauses.push(`alert_config = $${paramIndex++}`);
      params.push(JSON.stringify(updates.alertConfig));
    }
    if (updates.thresholds !== undefined) {
      setClauses.push(`thresholds = $${paramIndex++}`);
      params.push(JSON.stringify(updates.thresholds));
    }
    if (updates.connectionId !== undefined) {
      setClauses.push(`connection_id = $${paramIndex++}`);
      params.push(updates.connectionId);
    }

    if (setClauses.length === 0) {
      return this.getWebhook(id);
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const result = await this.pool.query(
      `UPDATE webhooks SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (result.rows.length === 0) return null;

    return this.mappers.mapWebhookRow(result.rows[0]);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query('DELETE FROM webhooks WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async createDelivery(delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>): Promise<WebhookDelivery> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query(
      `INSERT INTO webhook_deliveries (
        webhook_id, event_type, payload, status, status_code, response_body,
        attempts, next_retry_at, completed_at, duration_ms, connection_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        delivery.webhookId,
        delivery.eventType,
        JSON.stringify(delivery.payload),
        delivery.status,
        delivery.statusCode || null,
        delivery.responseBody || null,
        delivery.attempts,
        delivery.nextRetryAt ? new Date(delivery.nextRetryAt) : null,
        delivery.completedAt ? new Date(delivery.completedAt) : null,
        delivery.durationMs || null,
        delivery.connectionId || null,
      ]
    );

    return this.mappers.mapDeliveryRow(result.rows[0]);
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query('SELECT * FROM webhook_deliveries WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;

    return this.mappers.mapDeliveryRow(result.rows[0]);
  }

  async getDeliveriesByWebhook(webhookId: string, limit: number = 50, offset: number = 0): Promise<WebhookDelivery[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [webhookId, limit, offset]
    );

    return result.rows.map((row) => this.mappers.mapDeliveryRow(row));
  }

  async updateDelivery(id: string, updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.statusCode !== undefined) {
      setClauses.push(`status_code = $${paramIndex++}`);
      params.push(updates.statusCode);
    }
    if (updates.responseBody !== undefined) {
      setClauses.push(`response_body = $${paramIndex++}`);
      params.push(updates.responseBody);
    }
    if (updates.attempts !== undefined) {
      setClauses.push(`attempts = $${paramIndex++}`);
      params.push(updates.attempts);
    }
    if (updates.nextRetryAt !== undefined) {
      setClauses.push(`next_retry_at = $${paramIndex++}`);
      params.push(updates.nextRetryAt ? new Date(updates.nextRetryAt) : null);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push(`completed_at = $${paramIndex++}`);
      params.push(updates.completedAt ? new Date(updates.completedAt) : null);
    }
    if (updates.durationMs !== undefined) {
      setClauses.push(`duration_ms = $${paramIndex++}`);
      params.push(updates.durationMs);
    }

    if (setClauses.length === 0) return true;

    params.push(id);

    const result = await this.pool.query(
      `UPDATE webhook_deliveries SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params
    );

    return (result.rowCount ?? 0) > 0;
  }

  async getRetriableDeliveries(limit: number = 100, connectionId?: string): Promise<WebhookDelivery[]> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'retrying'
         AND next_retry_at <= NOW()
         AND connection_id = $2
         ORDER BY next_retry_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit, connectionId]
      );
      return result.rows.map((row) => this.mappers.mapDeliveryRow(row));
    }

    const result = await this.pool.query(
      `SELECT * FROM webhook_deliveries
       WHERE status = 'retrying'
       AND next_retry_at <= NOW()
       ORDER BY next_retry_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    return result.rows.map((row) => this.mappers.mapDeliveryRow(row));
  }

  async pruneOldDeliveries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM webhook_deliveries WHERE EXTRACT(EPOCH FROM created_at) * 1000 < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId]
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM webhook_deliveries WHERE EXTRACT(EPOCH FROM created_at) * 1000 < $1',
      [cutoffTimestamp]
    );

    return result.rowCount ?? 0;
  }

  // Slow Log Methods
  async saveSlowLogEntries(entries: StoredSlowLogEntry[], connectionId: string): Promise<number> {
    if (!this.pool || entries.length === 0) return 0;

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
        entry.command,  // PostgreSQL will accept string[] for TEXT[]
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
    if (!this.pool) throw new Error('Database not initialized');

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
      [...params, limit, offset]
    );

    return result.rows.map((row) => this.mappers.mapSlowLogEntryRow(row));
  }

  async getLatestSlowLogId(connectionId?: string): Promise<number | null> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'SELECT MAX(slowlog_id) as max_id FROM slow_log_entries WHERE connection_id = $1',
        [connectionId]
      );
      const maxId = result.rows[0]?.max_id;
      return maxId !== null && maxId !== undefined ? Number(maxId) : null;
    }

    const result = await this.pool.query(
      'SELECT MAX(slowlog_id) as max_id FROM slow_log_entries'
    );

    const maxId = result.rows[0]?.max_id;
    return maxId !== null && maxId !== undefined ? Number(maxId) : null;
  }

  async pruneOldSlowLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM slow_log_entries WHERE captured_at < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId]
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM slow_log_entries WHERE captured_at < $1',
      [cutoffTimestamp]
    );

    return result.rowCount ?? 0;
  }

  // Command Log Methods (Valkey-specific)
  async saveCommandLogEntries(entries: StoredCommandLogEntry[], connectionId: string): Promise<number> {
    if (!this.pool || entries.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const entry of entries) {
      placeholders.push(`(
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
        $${paramIndex++}, $${paramIndex++}, $${paramIndex++}
      )`);
      values.push(
        entry.id,
        entry.timestamp,
        entry.duration,
        entry.command,
        entry.clientAddress || '',
        entry.clientName || '',
        entry.type,
        entry.capturedAt,
        entry.sourceHost,
        entry.sourcePort,
        connectionId,
      );
    }

    const query = `
      INSERT INTO command_log_entries (
        commandlog_id, timestamp, duration, command,
        client_address, client_name, log_type, captured_at, source_host, source_port, connection_id
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (commandlog_id, log_type, source_host, source_port, connection_id) DO NOTHING
    `;

    const result = await this.pool.query(query, values);
    return result.rowCount ?? 0;
  }

  async getCommandLogEntries(options: CommandLogQueryOptions = {}): Promise<StoredCommandLogEntry[]> {
    if (!this.pool) throw new Error('Database not initialized');

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
      conditions.push(`command[1] ILIKE $${paramIndex++}`);
      params.push(`%${options.command}%`);
    }
    if (options.clientName) {
      conditions.push(`client_name ILIKE $${paramIndex++}`);
      params.push(`%${options.clientName}%`);
    }
    if (options.type) {
      conditions.push(`log_type = $${paramIndex++}`);
      params.push(options.type);
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
        commandlog_id, timestamp, duration, command,
        client_address, client_name, log_type, captured_at, source_host, source_port, connection_id
      FROM command_log_entries
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    return result.rows.map((row) => this.mappers.mapCommandLogEntryRow(row));
  }

  async getLatestCommandLogId(type: CommandLogType, connectionId?: string): Promise<number | null> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'SELECT MAX(commandlog_id) as max_id FROM command_log_entries WHERE log_type = $1 AND connection_id = $2',
        [type, connectionId]
      );
      const maxId = result.rows[0]?.max_id;
      return maxId !== null && maxId !== undefined ? Number(maxId) : null;
    }

    const result = await this.pool.query(
      'SELECT MAX(commandlog_id) as max_id FROM command_log_entries WHERE log_type = $1',
      [type]
    );

    const maxId = result.rows[0]?.max_id;
    return maxId !== null && maxId !== undefined ? Number(maxId) : null;
  }

  async pruneOldCommandLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM command_log_entries WHERE captured_at < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId]
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM command_log_entries WHERE captured_at < $1',
      [cutoffTimestamp]
    );

    return result.rowCount ?? 0;
  }

  // Connection Management Methods
  async saveConnection(config: import('../../common/interfaces/storage-port.interface').DatabaseConnectionConfig): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    await this.pool.query(`
      INSERT INTO connections (id, name, host, port, username, password, password_encrypted, db_index, tls, is_default, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT(id) DO UPDATE SET
        name = EXCLUDED.name,
        host = EXCLUDED.host,
        port = EXCLUDED.port,
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        password_encrypted = EXCLUDED.password_encrypted,
        db_index = EXCLUDED.db_index,
        tls = EXCLUDED.tls,
        is_default = EXCLUDED.is_default,
        updated_at = EXCLUDED.updated_at
    `, [
      config.id,
      config.name,
      config.host,
      config.port,
      config.username || null,
      config.password || null,
      config.passwordEncrypted || false,
      config.dbIndex || 0,
      config.tls || false,
      config.isDefault || false,
      config.createdAt,
      config.updatedAt || null,
    ]);
  }

  async getConnections(): Promise<import('../../common/interfaces/storage-port.interface').DatabaseConnectionConfig[]> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query('SELECT * FROM connections ORDER BY created_at ASC');

    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username || undefined,
      password: row.password || undefined,
      passwordEncrypted: row.password_encrypted || false,
      dbIndex: row.db_index,
      tls: row.tls,
      isDefault: row.is_default,
      createdAt: Number(row.created_at),
      updatedAt: row.updated_at ? Number(row.updated_at) : undefined,
    }));
  }

  async getConnection(id: string): Promise<import('../../common/interfaces/storage-port.interface').DatabaseConnectionConfig | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const result = await this.pool.query('SELECT * FROM connections WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username || undefined,
      password: row.password || undefined,
      passwordEncrypted: row.password_encrypted || false,
      dbIndex: row.db_index,
      tls: row.tls,
      isDefault: row.is_default,
      createdAt: Number(row.created_at),
      updatedAt: row.updated_at ? Number(row.updated_at) : undefined,
    };
  }

  async deleteConnection(id: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');
    await this.pool.query('DELETE FROM connections WHERE id = $1', [id]);
  }

  async updateConnection(id: string, updates: Partial<import('../../common/interfaces/storage-port.interface').DatabaseConnectionConfig>): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.host !== undefined) {
      setClauses.push(`host = $${paramIndex++}`);
      params.push(updates.host);
    }
    if (updates.port !== undefined) {
      setClauses.push(`port = $${paramIndex++}`);
      params.push(updates.port);
    }
    if (updates.username !== undefined) {
      setClauses.push(`username = $${paramIndex++}`);
      params.push(updates.username);
    }
    if (updates.password !== undefined) {
      setClauses.push(`password = $${paramIndex++}`);
      params.push(updates.password);
    }
    if (updates.dbIndex !== undefined) {
      setClauses.push(`db_index = $${paramIndex++}`);
      params.push(updates.dbIndex);
    }
    if (updates.tls !== undefined) {
      setClauses.push(`tls = $${paramIndex++}`);
      params.push(updates.tls);
    }
    if (updates.isDefault !== undefined) {
      setClauses.push(`is_default = $${paramIndex++}`);
      params.push(updates.isDefault);
    }

    if (setClauses.length === 0) return;

    setClauses.push(`updated_at = $${paramIndex++}`);
    params.push(Date.now());
    params.push(id);

    await this.pool.query(
      `UPDATE connections SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params
    );
  }
}
