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
  // An explicit deny (e.g. -exec, -@transaction) can still break AOF reload
  // under +@all, so any deny token defeats the unrestricted workaround.
  const hasExplicitDenial = commandTokens.some((token) => {
    return token.startsWith('-');
  });
  if (hasExplicitDenial) {
    return false;
  }
  const allCommands =
    commandTokens.includes('+@all') ||
    commandTokens.includes('allcommands') ||
    user.flags.includes('allcommands');

  const allKeys = user.keys.split(/\s+/).includes('~*') || user.flags.includes('allkeys');
  const allChannels =
    user.channels.split(/\s+/).includes('&*') || user.flags.includes('allchannels');

  return allCommands && allKeys && allChannels;
}

export interface AppendfsyncHazardInput {
  /** Value of `CONFIG GET appendonly` (`yes`/`no`), or null when unavailable. */
  appendonly: string | null;
  /** Value of `CONFIG GET appendfsync` (`always`/`everysec`/`no`), or null when unavailable. */
  appendfsync: string | null;
  /** INFO persistence `aof_delayed_fsync`, or null when absent. */
  aofDelayedFsync: number | null;
  /** Consecutive probes on which aof_delayed_fsync rose (service-computed across probes). */
  delayedFsyncRisingStreak: number;
  /** INFO persistence `aof_last_write_status`, or null when absent. */
  aofLastWriteStatus: string | null;
  /** Event names from LATENCY LATEST (empty when unsupported or clean). */
  latencyEvents: readonly string[];
}

/** LATENCY events proving AOF fsync is stalling the main thread. */
const AOF_LATENCY_EVENTS = ['aof-fsync-always', 'aof-write'];

const ALWAYS_ADVICE =
  'Consider appendfsync everysec unless per-write durability is a hard requirement, and check ' +
  'disk latency (valkey#3515).';

/**
 * AOF fsync-policy hazard (valkey#3515): with `appendfsync always` the fsync
 * happens on the main thread inside the write path, so a slow or contended
 * disk stalls command processing directly. The config alone is a low-severity
 * advisory; observed symptoms (aof_delayed_fsync rising across probes, an
 * aof-* LATENCY event, or a failing AOF write status) escalate it to a
 * confirmed hazard. `everysec` is flagged only when aof_delayed_fsync climbs
 * across at least two consecutive probes — the once-per-second background
 * fsync itself backing up — never on config alone.
 */
export function evaluateAppendfsyncHazard(
  input: AppendfsyncHazardInput,
): ConfigHazardFinding | null {
  if (input.appendonly !== 'yes') {
    return null;
  }

  if (input.appendfsync === 'always') {
    const symptoms: string[] = [];
    if (input.delayedFsyncRisingStreak >= 1 && input.aofDelayedFsync !== null) {
      symptoms.push(`aof_delayed_fsync is rising (now ${input.aofDelayedFsync})`);
    }
    if (input.aofLastWriteStatus !== null && input.aofLastWriteStatus !== 'ok') {
      symptoms.push(`aof_last_write_status=${input.aofLastWriteStatus}`);
    }
    const aofLatencyHits = input.latencyEvents.filter((event) => {
      return AOF_LATENCY_EVENTS.includes(event);
    });
    if (aofLatencyHits.length > 0) {
      symptoms.push(`LATENCY events: ${aofLatencyHits.join(', ')}`);
    }

    if (symptoms.length > 0) {
      return {
        id: 'appendfsync-always-blocking',
        severity: 'warning',
        status: 'hazard',
        message:
          `appendfsync=always is blocking the main thread on this instance: ${symptoms.join('; ')}. ` +
          `Every write fsyncs synchronously in the command path, so disk latency becomes command ` +
          `latency. ${ALWAYS_ADVICE}`,
      };
    }
    return {
      id: 'appendfsync-always-blocking',
      severity: 'info',
      status: 'advisory',
      message:
        `appendfsync=always fsyncs on the main thread for every write — a known latency risk on ` +
        `non-NVMe or contended disks. No blocking symptoms observed on this instance yet. ` +
        `${ALWAYS_ADVICE}`,
    };
  }

  if (input.appendfsync === 'everysec') {
    const steadilyClimbing = input.delayedFsyncRisingStreak >= 2 && input.aofDelayedFsync !== null;
    if (steadilyClimbing === false) {
      return null;
    }
    return {
      id: 'appendfsync-everysec-backlog',
      severity: 'warning',
      status: 'hazard',
      message:
        `The appendfsync=everysec background fsync is backing up: aof_delayed_fsync has risen on ` +
        `${input.delayedFsyncRisingStreak} consecutive probes (now ${input.aofDelayedFsync}) — ` +
        `writes were delayed because the previous fsync was still running. The disk cannot keep ` +
        `up with the once-per-second fsync; check disk latency and I/O contention (valkey#3515).`,
    };
  }

  return null;
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
