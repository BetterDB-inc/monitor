import {
  input,
  select,
  password as passwordPrompt,
  confirm,
} from '@inquirer/prompts';
import pc from 'picocolors';
import { BetterDBConfig, DEFAULT_CONFIG } from './types';
import { saveConfig, getDataDir, ensureDirectories } from './config';
import { printSuccess, printWarning, printInfo } from './banner';
import { join } from 'path';

/**
 * Check if better-sqlite3 is available
 */
function isSqliteAvailable(): boolean {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the interactive setup wizard
 */
export async function runSetupWizard(): Promise<BetterDBConfig> {
  console.log();
  console.log(pc.cyan(pc.bold('  BetterDB Setup Wizard')));
  console.log(pc.dim('  Configure your monitoring instance'));
  console.log();

  // Handle Ctrl+C gracefully
  const cleanup = () => {
    console.log();
    printInfo('Setup cancelled');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);

  try {
    const config = await promptConfiguration();

    // Save the configuration
    saveConfig(config);
    console.log();
    printSuccess(`Configuration saved to ~/.betterdb/config.json`);
    console.log();

    return config;
  } catch (error) {
    if ((error as Error).message?.includes('User force closed')) {
      cleanup();
    }
    throw error;
  } finally {
    process.off('SIGINT', cleanup);
  }
}

async function promptConfiguration(): Promise<BetterDBConfig> {
  // Database connection
  console.log(pc.dim('  Database Connection'));
  console.log();

  const dbHost = await input({
    message: 'Database host:',
    default: DEFAULT_CONFIG.database.host,
  });

  const dbPort = await input({
    message: 'Database port:',
    default: String(DEFAULT_CONFIG.database.port),
    validate: (value) => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        return 'Please enter a valid port number (1-65535)';
      }
      return true;
    },
  });

  const dbType = await select({
    message: 'Database type:',
    choices: [
      { name: 'Auto-detect', value: 'auto' as const },
      { name: 'Valkey', value: 'valkey' as const },
      { name: 'Redis', value: 'redis' as const },
    ],
    default: DEFAULT_CONFIG.database.type,
  });

  const dbUsername = await input({
    message: 'Database username:',
    default: DEFAULT_CONFIG.database.username,
  });

  const dbPassword = await passwordPrompt({
    message: 'Database password (leave empty for none):',
    mask: '*',
  });

  console.log();

  // Storage configuration
  console.log(pc.dim('  Storage Configuration'));
  console.log();

  const sqliteAvailable = isSqliteAvailable();

  const storageChoices: Array<{ name: string; value: 'sqlite' | 'postgres' | 'memory' }> = [];

  if (sqliteAvailable) {
    storageChoices.push({ name: 'SQLite (recommended)', value: 'sqlite' });
  } else {
    storageChoices.push({
      name: 'SQLite (requires: npm install better-sqlite3)',
      value: 'sqlite'
    });
  }
  storageChoices.push({ name: 'PostgreSQL', value: 'postgres' });
  storageChoices.push({ name: 'In-memory (no persistence)', value: 'memory' });

  const storageType = await select({
    message: 'Storage type:',
    choices: storageChoices,
    default: sqliteAvailable ? 'sqlite' : 'postgres',
  });

  let sqlitePath: string | undefined;
  let postgresUrl: string | undefined;

  if (storageType === 'sqlite') {
    if (!sqliteAvailable) {
      console.log();
      printWarning('better-sqlite3 is not installed.');
      printInfo('Run: npm install better-sqlite3');
      printInfo('Or choose a different storage type.');
      console.log();
    }

    ensureDirectories();
    const defaultSqlitePath = join(getDataDir(), 'audit.db');

    sqlitePath = await input({
      message: 'SQLite database path:',
      default: defaultSqlitePath,
    });
  } else if (storageType === 'postgres') {
    postgresUrl = await input({
      message: 'PostgreSQL connection URL:',
      default: 'postgresql://user:password@localhost:5432/betterdb',
      validate: (value) => {
        if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
          return 'URL must start with postgres:// or postgresql://';
        }
        return true;
      },
    });
  }

  console.log();

  // Application settings
  console.log(pc.dim('  Application Settings'));
  console.log();

  const appPort = await input({
    message: 'Server port:',
    default: String(DEFAULT_CONFIG.app.port),
    validate: (value) => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        return 'Please enter a valid port number (1-65535)';
      }
      return true;
    },
  });

  const anomalyDetection = await confirm({
    message: 'Enable anomaly detection?',
    default: DEFAULT_CONFIG.app.anomalyDetection,
  });

  console.log();

  // Optional: Security settings
  const configureAdvanced = await confirm({
    message: 'Configure advanced settings (encryption, license)?',
    default: false,
  });

  let encryptionKey: string | undefined;
  let licenseKey: string | undefined;

  if (configureAdvanced) {
    console.log();
    console.log(pc.dim('  Advanced Settings'));
    console.log();

    const encryptionKeyInput = await passwordPrompt({
      message: 'Encryption key (min 16 chars, leave empty to skip):',
      mask: '*',
      validate: (value) => {
        if (value && value.length < 16) {
          return 'Encryption key must be at least 16 characters';
        }
        return true;
      },
    });

    if (encryptionKeyInput) {
      encryptionKey = encryptionKeyInput;
      // Use the key for encryption during this run, but do not persist it.
      process.env.ENCRYPTION_KEY = encryptionKeyInput;
    }

    licenseKey = await input({
      message: 'License key (leave empty for community edition):',
    });

    if (!licenseKey) {
      licenseKey = undefined;
    }
  }

  if (encryptionKey) {
    console.log();
    printInfo('ENCRYPTION_KEY is not stored in config.');
    printInfo('Set ENCRYPTION_KEY in your environment before running BetterDB.');
  }

  return {
    database: {
      host: dbHost,
      port: parseInt(dbPort, 10),
      username: dbUsername,
      password: dbPassword,
      type: dbType,
    },
    storage: {
      type: storageType,
      sqlitePath: sqlitePath,
      postgresUrl: postgresUrl || undefined,
    },
    security: {},
    app: {
      port: parseInt(appPort, 10),
      anomalyDetection,
      licenseKey: licenseKey,
    },
  };
}
