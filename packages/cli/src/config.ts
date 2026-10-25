import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { BetterDBConfig, DEFAULT_CONFIG } from './types';
import { EnvelopeEncryptionService } from './encryption';

/**
 * Get the BetterDB configuration directory
 */
export function getConfigDir(): string {
  return join(homedir(), '.betterdb');
}

/**
 * Get the path to the config file
 */
export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

/**
 * Get the data directory path
 */
export function getDataDir(): string {
  return join(getConfigDir(), 'data');
}

/**
 * Check if configuration file exists
 */
export function configExists(): boolean {
  return existsSync(getConfigPath());
}

/**
 * Best-effort owner-only permissions. The config holds the database password
 * (plaintext unless ENCRYPTION_KEY is set) and the license key. POSIX modes
 * don't apply on Windows, and a chmod failure must never stop the CLI.
 */
function restrictPermissions(path: string, mode: number): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    chmodSync(path, mode);
  } catch {
    // ignore: e.g. a directory owned by another user
  }
}

/**
 * Ensure all required directories exist, readable only by the current user
 */
export function ensureDirectories(): void {
  const configDir = getConfigDir();
  const dataDir = getDataDir();

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  // mkdir's mode is ignored for existing dirs, so tighten them on every run
  restrictPermissions(configDir, 0o700);

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  restrictPermissions(dataDir, 0o700);
}

/**
 * Load configuration from file
 */
export function loadConfig(): BetterDBConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  // Tighten installs written by older versions, which used the default modes
  restrictPermissions(getConfigDir(), 0o700);
  restrictPermissions(getDataDir(), 0o700);
  restrictPermissions(configPath, 0o600);

  let parsed: Partial<BetterDBConfig>;
  try {
    const content = readFileSync(configPath, 'utf-8');
    parsed = JSON.parse(content);
  } catch (error) {
    console.error('Warning: Failed to parse config file, using defaults');
    return DEFAULT_CONFIG;
  }

  // Merge with defaults to ensure all fields exist
  const merged: BetterDBConfig = {
    database: { ...DEFAULT_CONFIG.database, ...parsed.database },
    storage: { ...DEFAULT_CONFIG.storage, ...parsed.storage },
    security: { ...DEFAULT_CONFIG.security, ...parsed.security, encryptionKey: undefined },
    app: { ...DEFAULT_CONFIG.app, ...parsed.app },
  };

  return decryptConfig(merged);
}

/**
 * Save configuration to file
 */
export function saveConfig(config: BetterDBConfig): void {
  ensureDirectories();
  const configPath = getConfigPath();
  const configToSave = encryptConfig({
    ...config,
    security: { ...config.security, encryptionKey: undefined },
  });
  writeFileSync(configPath, JSON.stringify(configToSave, null, 2), { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file
  restrictPermissions(configPath, 0o600);
}

/**
 * Expand ~ to home directory in paths
 */
export function expandPath(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  if (path.startsWith('~')) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

function getEncryptionKey(): string | undefined {
  return process.env.ENCRYPTION_KEY;
}

function encryptConfig(config: BetterDBConfig): BetterDBConfig {
  const key = getEncryptionKey();
  const password = config.database.password;
  if (!key || !password || EnvelopeEncryptionService.isEncrypted(password)) {
    return config;
  }

  try {
    const encryption = new EnvelopeEncryptionService(key);
    return {
      ...config,
      database: {
        ...config.database,
        password: encryption.encrypt(password),
      },
    };
  } catch (error) {
    console.warn('Warning: Failed to encrypt database password, storing plaintext');
    return config;
  }
}

function decryptConfig(config: BetterDBConfig): BetterDBConfig {
  const password = config.database.password;
  if (!password || !EnvelopeEncryptionService.isEncrypted(password)) {
    return config;
  }

  const key = getEncryptionKey();
  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY not set; database password is encrypted. ' +
      'Set ENCRYPTION_KEY and retry, or re-run setup to update credentials.'
    );
  }

  try {
    const encryption = new EnvelopeEncryptionService(key);
    return {
      ...config,
      database: {
        ...config.database,
        password: encryption.decrypt(password),
      },
    };
  } catch (error) {
    throw new Error(
      'Failed to decrypt stored database password. ' +
      'Check ENCRYPTION_KEY or re-run setup to update credentials.'
    );
  }
}
