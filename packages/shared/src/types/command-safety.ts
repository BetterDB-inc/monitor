/**
 * Commands allowed in safe/read-only mode.
 * Used by the cloud agent and CLI safe mode.
 */
export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'PING', 'INFO', 'DBSIZE',
  'SLOWLOG', 'COMMANDLOG',
  'LATENCY',
  'CLIENT',
  'ACL',
  'CONFIG',
  'CLUSTER',
  'MEMORY',
  'COMMAND',
  'ROLE',
  'LASTSAVE',
  'COLLECT_KEY_ANALYTICS',
  'FT',
  'HGETFIELD_BUFFER',
]);

/**
 * Subcommand restrictions for allowed commands.
 */
export const ALLOWED_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  CONFIG: new Set(['GET']),
  CLIENT: new Set(['LIST', 'INFO', 'GETNAME']),
  ACL: new Set(['LOG', 'LIST', 'WHOAMI', 'USERS']),
  SLOWLOG: new Set(['GET', 'LEN', 'RESET']),
  COMMANDLOG: new Set(['GET', 'LEN', 'RESET']),
  LATENCY: new Set(['LATEST', 'HISTORY', 'HISTOGRAM', 'RESET', 'DOCTOR']),
  CLUSTER: new Set(['INFO', 'SLOTS', 'SLOT-STATS', 'NODES']),
  MEMORY: new Set(['DOCTOR', 'STATS']),
  COMMAND: new Set(['COUNT', 'DOCS']),
  FT: new Set(['_LIST', 'INFO', 'SEARCH']),
};

/**
 * Commands that are always blocked regardless of mode.
 * These block the connection, stream indefinitely, or are dangerous.
 */
export const BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE',
  'BLPOP', 'BRPOP', 'BRPOPLPUSH', 'BLMOVE', 'BLMPOP',
  'BZPOPMIN', 'BZPOPMAX', 'BZMPOP',
  'XREAD', 'XREADGROUP',
  'WAIT', 'WAITAOF',
  'MONITOR', 'DEBUG',
]);

/**
 * Subcommands that are always blocked regardless of mode.
 */
export const BLOCKED_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  CLIENT: new Set(['PAUSE']),
};

/**
 * Check if a command is always blocked (regardless of mode).
 * Returns an error message string, or null if not blocked.
 */
export function checkBlocked(command: string, subCommand?: string): string | null {
  if (BLOCKED_COMMANDS.has(command)) {
    return `Command ${command} is blocked. It may block the connection or is dangerous.`;
  }
  if (subCommand && BLOCKED_SUBCOMMANDS[command]?.has(subCommand)) {
    return `Command ${command} ${subCommand} is blocked.`;
  }
  return null;
}

/**
 * Check if a command is allowed in safe (read-only) mode.
 * Returns an error message string, or null if allowed.
 */
export function checkSafeMode(command: string, subCommand?: string): string | null {
  if (!ALLOWED_COMMANDS.has(command)) {
    return `Command ${command} is not allowed in safe mode.`;
  }

  const allowedSubs = ALLOWED_SUBCOMMANDS[command];
  if (allowedSubs) {
    if (!subCommand) {
      return `Command ${command} requires a sub-command in safe mode (e.g., ${command} ${[...allowedSubs][0]}).`;
    }
    if (!allowedSubs.has(subCommand)) {
      return `Command ${command} ${subCommand} is not allowed in safe mode.`;
    }
  }

  return null;
}
