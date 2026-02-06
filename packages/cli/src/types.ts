/**
 * Configuration interfaces for BetterDB CLI
 */

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  type: 'valkey' | 'redis' | 'auto';
}

export interface StorageConfig {
  type: 'sqlite' | 'postgres' | 'memory';
  sqlitePath?: string;
  postgresUrl?: string;
}

export interface SecurityConfig {
  encryptionKey?: string;
}

export interface AppConfig {
  port: number;
  anomalyDetection: boolean;
  licenseKey?: string;
}

export interface BetterDBConfig {
  database: DatabaseConfig;
  storage: StorageConfig;
  security: SecurityConfig;
  app: AppConfig;
}

export interface CLIOptions {
  setup?: boolean; // true when --setup, false when --no-setup, undefined otherwise
  port?: number;
  dbHost?: string;
  dbPort?: number;
  storageType?: 'sqlite' | 'postgres' | 'memory';
}

export const DEFAULT_CONFIG: BetterDBConfig = {
  database: {
    host: 'localhost',
    port: 6379,
    username: 'default',
    password: '',
    type: 'auto',
  },
  storage: {
    type: 'sqlite',
    sqlitePath: '~/.betterdb/data/audit.db',
  },
  security: {},
  app: {
    port: 3001,
    anomalyDetection: true,
  },
};
