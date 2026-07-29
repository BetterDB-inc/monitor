/**
 * Static config-hazard evaluation (valkey#3983): a node running with the
 * `default` ACL user disabled while AOF is enabled silently drops MULTI/EXEC
 * and function-replicated writes on AOF reload, unless `default` carries the
 * unrestricted `+@all ~* &*` workaround grant. We cannot fix the server; we
 * detect the dangerous configuration and advise the fix.
 */

import { ConfigHazardFinding } from '@betterdb/shared';

export type { ConfigHazardFinding };

export interface ConfigHazardInput {
  /** Value of `CONFIG GET appendonly` (`yes`/`no`), or null when unavailable. */
  appendonly: string | null;
  /** Server version from capabilities, or null when unknown. */
  version: string | null;
  /** Raw `ACL GETUSER default` reply (RESP2 pair array or RESP3 record), or 'denied' when the probe was refused. */
  aclGetUserResult: unknown;
}

const HAZARD_MESSAGE =
  'The default user is disabled with AOF enabled — EXEC/function writes can be silently lost on ' +
  'AOF reload (valkey#3983). Grant `default +@all ~* &*`, or keep the user enabled.';

const UNVERIFIED_MESSAGE =
  'AOF is enabled but the default user ACL could not be verified — if the ' +
  'default user is disabled without `+@all ~* &*`, EXEC/function writes can be silently lost on ' +
  'AOF reload (valkey#3983).';

function unverifiedFinding(reason: string): ConfigHazardFinding {
  return {
    id: 'default-user-aof-data-loss',
    severity: 'warning',
    status: 'unverified',
    message: `${UNVERIFIED_MESSAGE} (could not verify the default user's grants: ${reason})`,
  };
}

export function evaluateAclAofHazard(input: ConfigHazardInput): ConfigHazardFinding | null {
  if (input.appendonly !== 'yes') {
    return null;
  }
  if (isPreAclVersion(input.version)) {
    return null;
  }

  if (input.aclGetUserResult === 'denied') {
    return unverifiedFinding('ACL GETUSER was denied');
  }

  // A nil or unparseable reply must not read as "clean": only a positively
  // verified safe configuration may return null (same contract as the denied
  // path — never a silent false negative).
  const user = parseAclUser(input.aclGetUserResult);
  if (user === null) {
    return unverifiedFinding('unexpected ACL GETUSER reply');
  }

  const isDisabled = user.flags.includes('off');
  if (isDisabled === false) {
    return null;
  }

  if (hasUnrestrictedGrant(user)) {
    return null;
  }

  return {
    id: 'default-user-aof-data-loss',
    severity: 'warning',
    status: 'hazard',
    message: HAZARD_MESSAGE,
  };
}

interface ParsedAclUser {
  flags: string[];
  commands: string;
  keys: string;
  channels: string;
}

/**
 * `ACL GETUSER` returns either a RESP3 record or a RESP2 flat [key, value, ...]
 * pair array (same duality handled by acl-checker.ts for the commands field).
 */
function parseAclUser(raw: unknown): ParsedAclUser | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw === 'object' && Array.isArray(raw) === false) {
    const obj = raw as Record<string, unknown>;
    return {
      flags: toStringArray(obj.flags),
      commands: toStringValue(obj.commands),
      keys: toStringValue(obj.keys),
      channels: toStringValue(obj.channels),
    };
  }

  if (Array.isArray(raw)) {
    const fields: Record<string, unknown> = {};
    for (let i = 0; i < raw.length - 1; i += 2) {
      const key = raw[i];
      if (typeof key === 'string') {
        fields[key] = raw[i + 1];
      }
    }
    return {
      flags: toStringArray(fields.flags),
      commands: toStringValue(fields.commands),
      keys: toStringValue(fields.keys),
      channels: toStringValue(fields.channels),
    };
  }

  return null;
}

function hasUnrestrictedGrant(user: ParsedAclUser): boolean {
  const commandTokens = user.commands.split(/\s+/).filter(Boolean);
  const allCommands =
    commandTokens.includes('+@all') ||
    commandTokens.includes('allcommands') ||
    user.flags.includes('allcommands');

  const allKeys = user.keys.split(/\s+/).includes('~*') || user.flags.includes('allkeys');
  const allChannels =
    user.channels.split(/\s+/).includes('&*') || user.flags.includes('allchannels');

  return allCommands && allKeys && allChannels;
}

function isPreAclVersion(version: string | null): boolean {
  if (version === null || version === '') {
    return false;
  }
  const major = parseInt(version, 10);
  if (Number.isFinite(major) === false) {
    return false;
  }
  return major < 6;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => {
      return typeof entry === 'string';
    });
  }
  if (typeof value === 'string') {
    return value.split(/\s+/).filter(Boolean);
  }
  return [];
}

function toStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return '';
}
