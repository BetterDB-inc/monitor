import { Command } from 'commander';
import { existsSync } from 'fs';
import { configExists, loadConfig, getConfigPath } from './config';
import { printBanner, printStartupInfo, printError, printInfo, printSuccess } from './banner';
import { runSetupWizard } from './setup';
import { startServer, setupSignalHandlers, getServerPath } from './runner';
import { BetterDBConfig, CLIOptions } from './types';
import { join } from 'path';

// Read version from package.json
const packageJson = require('../package.json');
const VERSION = packageJson.version;

const program = new Command();

program
  .name('betterdb')
  .description('Monitor and observe your Valkey/Redis databases')
  .version(VERSION, '-v, --version', 'Display version number')
  .option('-s, --setup', 'Run the setup wizard')
  .option('--no-setup', 'Skip setup wizard even if no config exists')
  .option('-p, --port <port>', 'Server port', parseInt)
  .option('--db-host <host>', 'Database host')
  .option('--db-port <port>', 'Database port', parseInt)
  .option('--storage-type <type>', 'Storage type (sqlite, postgres, memory)')
  .action(runCli);

// Add setup subcommand (setup only, doesn't start server)
program
  .command('setup')
  .description('Run the interactive setup wizard (without starting server)')
  .action(async () => {
    printBanner(VERSION);
    await runSetupWizard();
  });

async function runCli(options: CLIOptions): Promise<void> {
  printBanner(VERSION);

  // Check if bundled server exists
  const serverPath = getServerPath();
  if (!existsSync(serverPath)) {
    printError('Bundled server not found.');
    printInfo('This usually means the package was not built correctly.');
    printInfo('If running from source, run: pnpm cli:build');
    process.exit(1);
  }

  // Load or create configuration
  let config: BetterDBConfig;

  // Commander's --no-setup sets options.setup to false
  const skipSetup = options.setup === false;

  // Run setup if explicitly requested or if no config exists
  if (options.setup || (!configExists() && !skipSetup)) {
    if (!options.setup) {
      printInfo('No configuration found. Starting setup wizard...');
      console.log();
    }
    try {
      config = await runSetupWizard();
    } catch (error) {
      printError((error as Error).message);
      process.exit(1);
    }
  } else if (!configExists()) {
    printError('No configuration found.');
    printInfo(`Run 'betterdb --setup' or create config at ${getConfigPath()}`);
    process.exit(1);
  } else {
    try {
      config = loadConfig();
    } catch (error) {
      printError((error as Error).message);
      process.exit(1);
    }
  }

  // Apply CLI overrides
  config = applyCliOverrides(config, options);

  // Print startup info
  printStartupInfo(config);

  // Setup graceful shutdown
  setupSignalHandlers();

  // Start the server
  printInfo('Starting server...');
  console.log();

  try {
    await startServer(config);
  } catch (error) {
    printError(`Failed to start: ${(error as Error).message}`);
    process.exit(1);
  }
}

function applyCliOverrides(config: BetterDBConfig, options: CLIOptions): BetterDBConfig {
  const result = { ...config };

  if (options.port) {
    result.app = { ...result.app, port: options.port };
  }

  if (options.dbHost) {
    result.database = { ...result.database, host: options.dbHost };
  }

  if (options.dbPort) {
    result.database = { ...result.database, port: options.dbPort };
  }

  if (options.storageType) {
    const validTypes = ['sqlite', 'postgres', 'memory'] as const;
    if (validTypes.includes(options.storageType as any)) {
      result.storage = { ...result.storage, type: options.storageType as typeof validTypes[number] };
    }
  }

  return result;
}

program.parse();
