export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  type: 'valkey' | 'redis' | 'auto';
}

export interface StorageConfig {
  type: 'sqlite';
  sqlite: {
    filepath: string;
  };
  audit: {
    enabled: boolean;
    pollIntervalMs: number;
    retentionDays: number;
  };
}

export interface AppConfig {
  database: DatabaseConfig;
  storage: StorageConfig;
}

export default (): AppConfig => ({
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '6379', 10),
    username: process.env.DB_USERNAME || 'default',
    password: process.env.DB_PASSWORD || '',
    type: (process.env.DB_TYPE as 'valkey' | 'redis' | 'auto') || 'auto',
  },
  storage: {
    type: 'sqlite',
    sqlite: {
      filepath: process.env.STORAGE_SQLITE_PATH || './data/audit.db',
    },
    audit: {
      enabled: process.env.AUDIT_ENABLED === 'true' || true,
      pollIntervalMs: parseInt(process.env.AUDIT_POLL_INTERVAL_MS || '60000', 10),
      retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '30', 10),
    },
  },
});
