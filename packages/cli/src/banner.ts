import pc from 'picocolors';
import { BetterDBConfig } from './types';

/**
 * Print the startup banner
 */
export function printBanner(version: string): void {
  console.log();
  console.log(pc.cyan(pc.bold('  BetterDB Monitor')));
  console.log(pc.dim(`  v${version}`));
  console.log();
}

/**
 * Print startup information
 */
export function printStartupInfo(config: BetterDBConfig): void {
  const { database, storage, app } = config;

  console.log(pc.dim('  Database:'));
  console.log(`    ${pc.cyan('Host:')} ${database.host}:${database.port}`);
  console.log(`    ${pc.cyan('Type:')} ${database.type}`);
  if (database.username && database.username !== 'default') {
    console.log(`    ${pc.cyan('User:')} ${database.username}`);
  }
  console.log();

  console.log(pc.dim('  Storage:'));
  console.log(`    ${pc.cyan('Type:')} ${storage.type}`);
  if (storage.type === 'sqlite' && storage.sqlitePath) {
    console.log(`    ${pc.cyan('Path:')} ${storage.sqlitePath}`);
  } else if (storage.type === 'postgres' && storage.postgresUrl) {
    // Mask the password in the URL
    const maskedUrl = storage.postgresUrl.replace(
      /:([^:@]+)@/,
      ':****@'
    );
    console.log(`    ${pc.cyan('URL:')} ${maskedUrl}`);
  }
  console.log();

  console.log(pc.dim('  Server:'));
  console.log(`    ${pc.cyan('URL:')} ${pc.underline(`http://localhost:${app.port}`)}`);
  console.log(`    ${pc.cyan('API:')} ${pc.underline(`http://localhost:${app.port}/api`)}`);
  console.log(`    ${pc.cyan('Docs:')} ${pc.underline(`http://localhost:${app.port}/api/docs`)}`);
  console.log();
}

/**
 * Print a success message
 */
export function printSuccess(message: string): void {
  console.log(pc.green(`  ✓ ${message}`));
}

/**
 * Print an error message
 */
export function printError(message: string): void {
  console.log(pc.red(`  ✗ ${message}`));
}

/**
 * Print a warning message
 */
export function printWarning(message: string): void {
  console.log(pc.yellow(`  ! ${message}`));
}

/**
 * Print an info message
 */
export function printInfo(message: string): void {
  console.log(pc.dim(`  ${message}`));
}
