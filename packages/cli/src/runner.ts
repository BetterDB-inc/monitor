import { fork, ChildProcess } from 'child_process';
import { join } from 'path';
import { BetterDBConfig } from './types';
import { expandPath } from './config';
import { printError, printInfo } from './banner';

let serverProcess: ChildProcess | null = null;

/**
 * Map configuration to environment variables
 */
export function mapConfigToEnv(
  config: BetterDBConfig,
  staticDir: string
): Record<string, string> {
  const env: Record<string, string> = {
    // Always set these for CLI mode
    NODE_ENV: 'production',
    AI_ENABLED: 'false',

    // Static directory for bundled web assets
    BETTERDB_STATIC_DIR: staticDir,

    // Database connection
    DB_HOST: config.database.host,
    DB_PORT: String(config.database.port),
    DB_USERNAME: config.database.username,
    DB_PASSWORD: config.database.password,
    DB_TYPE: config.database.type,

    // Storage configuration
    STORAGE_TYPE: config.storage.type,

    // Application settings
    PORT: String(config.app.port),
    ANOMALY_DETECTION_ENABLED: config.app.anomalyDetection ? 'true' : 'false',
  };

  // Add SQLite path if configured
  if (config.storage.type === 'sqlite' && config.storage.sqlitePath) {
    env.STORAGE_SQLITE_FILEPATH = expandPath(config.storage.sqlitePath);
  }

  // Add PostgreSQL URL if configured
  if (config.storage.type === 'postgres' && config.storage.postgresUrl) {
    env.STORAGE_URL = config.storage.postgresUrl;
  }

  // Add license key if configured
  if (config.app.licenseKey) {
    env.BETTERDB_LICENSE_KEY = config.app.licenseKey;
  }

  return env;
}

/**
 * Get the path to the bundled server
 */
export function getServerPath(): string {
  return join(__dirname, '..', 'assets', 'server', 'index.js');
}

/**
 * Get the path to the bundled web assets
 */
export function getStaticDir(): string {
  return join(__dirname, '..', 'assets', 'web');
}

/**
 * Start the server with the given configuration
 */
export function startServer(config: BetterDBConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverPath = getServerPath();
    const staticDir = getStaticDir();
    const env = mapConfigToEnv(config, staticDir);

    // Merge with current process env
    const fullEnv = { ...process.env, ...env };

    serverProcess = fork(serverPath, [], {
      env: fullEnv,
      stdio: 'inherit',
    });

    let started = false;

    serverProcess.once('spawn', () => {
      started = true;
      resolve();
    });

    serverProcess.on('error', (error) => {
      printError(`Failed to start server: ${error.message}`);
      reject(error);
    });

    serverProcess.on('exit', (code, signal) => {
      serverProcess = null;

      if (code !== null) {
        if (code !== 0) {
          printError(`Server exited with code ${code}`);
          if (!started) {
            reject(new Error(`Server exited with code ${code}`));
            return;
          }
          process.exit(code);
        }
        return;
      }

      if (signal) {
        printInfo(`Server killed by signal ${signal}`);
        if (!started) {
          reject(new Error(`Server killed by signal ${signal}`));
          return;
        }
        process.exit(1);
      }
    });
  });
}

/**
 * Setup signal handlers for graceful shutdown
 */
export function setupSignalHandlers(): void {
  const shutdown = (signal: string) => {
    console.log();
    printInfo(`Received ${signal}, shutting down...`);

    if (serverProcess) {
      serverProcess.kill('SIGTERM');

      // Force kill after timeout
      setTimeout(() => {
        if (serverProcess) {
          serverProcess.kill('SIGKILL');
        }
        process.exit(0);
      }, 5000);
    } else {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
