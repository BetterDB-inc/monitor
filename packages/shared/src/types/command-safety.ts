/**
 * Commands allowed in safe/read-only mode.
 * Used by the cloud agent and CLI safe mode.
 */
export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'PING',
  'INFO',
  'DBSIZE',
  'SLOWLOG',
  'COMMANDLOG',
  'LATENCY',
  'CLIENT',
  'ACL',
  'CONFIG',
  'CLUSTER',
  'SENTINEL',
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
  CLUSTER: new Set(['INFO', 'SLOTS', 'SLOT-STATS', 'NODES', 'SHARDS']),
  // Read-only topology views used by the Sentinel drift detector.
  SENTINEL: new Set(['MASTERS', 'REPLICAS', 'SENTINELS']),
  MEMORY: new Set(['DOCTOR', 'STATS']),
  COMMAND: new Set(['COUNT', 'DOCS']),
  FT: new Set(['_LIST', 'INFO', 'SEARCH']),
};

/**
 * Commands that are always blocked regardless of mode.
 * These block the connection, stream indefinitely, or are dangerous.
 */
export const BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  'SUBSCRIBE',
  'PSUBSCRIBE',
  'SSUBSCRIBE',
  'BLPOP',
  'BRPOP',
  'BRPOPLPUSH',
  'BLMOVE',
  'BLMPOP',
  'BZPOPMIN',
  'BZPOPMAX',
  'BZMPOP',
  'XREAD',
  'XREADGROUP',
  'WAIT',
  'WAITAOF',
  'MONITOR',
  'DEBUG',
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

const MEMBER_DENIED_COMMANDS: ReadonlySet<string> = new Set(['CONFIG', 'ACL', 'DEBUG', 'CLIENT']);

const MEMBER_DENIED_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  SLOWLOG: new Set(['RESET']),
  COMMANDLOG: new Set(['RESET']),
  LATENCY: new Set(['RESET']),
};

export const MEMBER_DENIED_MESSAGE = 'Command not available to read-only members.';

/**
 * Check if a command may run for a read-only workspace member.
 * Members get the safe-mode allowlist minus commands that expose
 * server configuration, credentials or client details, and minus the
 * RESET sub-commands that clear diagnostic state.
 * Returns an error message string, or null if allowed.
 */
export function checkMemberReadOnly(command: string, subCommand?: string): string | null {
  if (MEMBER_DENIED_COMMANDS.has(command)) {
    return MEMBER_DENIED_MESSAGE;
  }
  const deniedSubs = MEMBER_DENIED_SUBCOMMANDS[command];
  if (deniedSubs !== undefined && subCommand !== undefined && deniedSubs.has(subCommand)) {
    return MEMBER_DENIED_MESSAGE;
  }
  return checkSafeMode(command, subCommand);
}

export const AGENT_READ_ONLY_MESSAGE = 'This agent connection is read-only.';

/**
 * Whether the server has CLUSTER SLOT-STATS: Valkey 8.0+, Redis 8.2+. Shared
 * by the direct adapter and the agent adapter so the two never disagree.
 */
export function supportsClusterSlotStats(type: 'valkey' | 'redis', version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => parseInt(part, 10) || 0);
  return type === 'valkey' ? major >= 8 : major > 8 || (major === 8 && minor >= 2);
}

/**
 * CONFIG parameters whose values are credentials. A read-only agent connection
 * holds the admin user, so CONFIG GET on these (or on a glob covering them,
 * like `*`) must not hand the password to whoever can reach the Monitor.
 */
export const SECRET_CONFIG_PARAMETERS: ReadonlySet<string> = new Set([
  'requirepass',
  'masterauth',
  'masteruser',
  'primaryauth',
  'primaryuser',
  'tls-key-file-pass',
  'tls-client-key-file-pass',
]);

export const REDACTED_CONFIG_VALUE = '<redacted>';

export function isSecretConfigParameter(name: string): boolean {
  return SECRET_CONFIG_PARAMETERS.has(name.toLowerCase());
}

/**
 * Redacts credential values in a CONFIG GET reply, which is a flat
 * [name, value, name, value, ...] array (RESP2) or a name -> value object
 * (RESP3). Anything else is returned untouched. Redacting rather than denying
 * keeps `CONFIG GET *` and the Monitor's own maxmemory/eviction reads working.
 */
export function redactConfigGetReply(reply: unknown): unknown {
  if (Array.isArray(reply)) {
    if (reply.length % 2 !== 0) return reply;
    const out = reply.slice();
    for (let i = 0; i + 1 < out.length; i += 2) {
      const name = out[i];
      if (typeof name === 'string' && isSecretConfigParameter(name) && out[i + 1] !== '') {
        out[i + 1] = REDACTED_CONFIG_VALUE;
      }
    }
    return out;
  }
  if (reply !== null && typeof reply === 'object') {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(reply as Record<string, unknown>)) {
      out[name] = isSecretConfigParameter(name) && value !== '' ? REDACTED_CONFIG_VALUE : value;
    }
    return out;
  }
  return reply;
}

const ACL_HASH_TOKEN = /(^|\s)#[0-9a-f]{64}(?=\s|$)/gi;
const ACL_PASSWORD_TOKEN = /(^|\s)[><][^\s]+/g;
const ACL_HASH = /^[0-9a-f]{64}$/i;

/** One ACL rule string (`ACL LIST` line, `ACL GETUSER` flags): hashes and passwords redacted. */
function redactAclRule(rule: string): string {
  return rule.replace(ACL_HASH_TOKEN, '$1#<redacted>').replace(ACL_PASSWORD_TOKEN, (match) => `${match[0] === ' ' ? ' ' : ''}${match.trim()[0]}<redacted>`);
}

function redactAclList(reply: unknown): unknown {
  return Array.isArray(reply) ? reply.map((line) => (typeof line === 'string' ? redactAclRule(line) : line)) : reply;
}

// ACL GETUSER: a flat [field, value, ...] array (RESP2) or an object (RESP3);
// `passwords` holds the hashes, and the flags/commands fields are rule text.
function redactAclGetUser(reply: unknown): unknown {
  const redactValue = (field: unknown, value: unknown): unknown => {
    if (field === 'passwords' && Array.isArray(value)) {
      return value.map((hash) => (typeof hash === 'string' && ACL_HASH.test(hash) ? '<redacted>' : hash));
    }
    return typeof value === 'string' ? redactAclRule(value) : value;
  };
  if (Array.isArray(reply)) {
    if (reply.length % 2 !== 0) return reply;
    const out = reply.slice();
    for (let i = 0; i + 1 < out.length; i += 2) out[i + 1] = redactValue(out[i], out[i + 1]);
    return out;
  }
  if (reply !== null && typeof reply === 'object') {
    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(reply as Record<string, unknown>)) out[field] = redactValue(field, value);
    return out;
  }
  return reply;
}

/**
 * Strips credentials from the replies a read-only agent connection may carry:
 * CONFIG GET values (see redactConfigGetReply), the password hashes in ACL
 * LIST rules and the `passwords` of ACL GETUSER. Every other reply passes
 * through untouched, so the Monitor's ACL and config views keep working.
 */
export function redactSensitiveReply(command: string, args: readonly string[] | undefined, reply: unknown): unknown {
  const cmd = command.toUpperCase();
  const sub = args?.[0]?.toUpperCase();
  if (cmd === 'CONFIG' && sub === 'GET') return redactConfigGetReply(reply);
  if (cmd === 'ACL' && sub === 'LIST') return redactAclList(reply);
  if (cmd === 'ACL' && sub === 'GETUSER') return redactAclGetUser(reply);
  return reply;
}

/**
 * Check if a command may run on a read-only agent connection, one where the
 * agent holds admin credentials it is not meant to change state with (the
 * OpenEverest plugin). Read-only is the safe-mode allowlist minus everything
 * that mutates the server: the RESET sub-commands and ACL LOG RESET on top of
 * what safe mode already keeps out (CLIENT KILL, CONFIG SET, writes).
 * Returns an error message string, or null if allowed.
 */
export function checkAgentReadOnly(command: string, args?: readonly string[]): string | null {
  const subCommand = args?.[0]?.toUpperCase();
  // The same RESET sub-commands a read-only member may not run.
  if (subCommand !== undefined && MEMBER_DENIED_SUBCOMMANDS[command]?.has(subCommand)) {
    return AGENT_READ_ONLY_MESSAGE;
  }
  if (command === 'ACL' && subCommand === 'LOG' && args?.[1]?.toUpperCase() === 'RESET') {
    return AGENT_READ_ONLY_MESSAGE;
  }
  return checkSafeMode(command, subCommand) === null ? null : AGENT_READ_ONLY_MESSAGE;
}
