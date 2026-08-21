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

export interface ClusterCrcHazardInput {
  /**
   * Value of `CONFIG GET cluster-enabled` (`yes`/`no`), or null when the read
   * returned no value. Note that `getConfigValue` resolves an empty/filtered
   * reply to null WITHOUT throwing (managed offerings and proxies commonly
   * filter CONFIG GET), so null here means "cluster mode unknown", not "off".
   */
  clusterEnabled: string | null;
  /** Value of `CONFIG GET cluster-crc-enabled` (`yes`/`no`), or null when the build predates valkey#4201. */
  clusterCrcEnabled: string | null;
}

const CLUSTER_CRC_HAZARD_MESSAGE =
  'Cluster mode is on but the cluster-bus CRC integrity check is disabled ' +
  '(`cluster-crc-enabled no`). A corrupted gossip message can then be accepted and ' +
  'scramble slot ownership through a bogus configEpoch (valkey#4201). Enable it with ' +
  '`CONFIG SET cluster-crc-enabled yes` on every node so corruption is rejected and ' +
  'counted in cluster_stats_messages_crc_mismatch.';

const CLUSTER_CRC_UNVERIFIED_MESSAGE =
  'Cluster-bus CRC integrity could not be verified because `CONFIG GET ' +
  'cluster-enabled` returned no value (commonly a proxy or managed offering ' +
  'filtering CONFIG GET). If this is a cluster running `cluster-crc-enabled no`, ' +
  'a corrupted gossip message can scramble slot ownership (valkey#4201).';

/**
 * valkey#4201: a cluster running with `cluster-crc-enabled no` (the server
 * default) only validates the magic string and message length on the bus, so a
 * bit-flipped gossip packet can be accepted and permanently corrupt slot
 * ownership. Only a positively verified state (cluster off, feature absent, or
 * the check already on) returns null — never a silent false negative. A cluster
 * state we could not read is surfaced as 'unverified', mirroring the AOF
 * evaluator's denied path, so it is never cached as clean.
 */
export function evaluateClusterCrcHazard(input: ClusterCrcHazardInput): ConfigHazardFinding | null {
  // Cluster mode unknown: the read returned no value (filtered CONFIG GET), so
  // we cannot conclude the bus is safe. Surface it rather than reading as clean.
  if (input.clusterEnabled === null) {
    return {
      id: 'cluster-crc-disabled',
      severity: 'warning',
      status: 'unverified',
      message: CLUSTER_CRC_UNVERIFIED_MESSAGE,
    };
  }
  if (input.clusterEnabled !== 'yes') {
    return null;
  }
  // A null value means the parameter is unknown to this build (pre-#4201), so
  // there is nothing to advise. Only an explicit `no` is a hazard.
  if (input.clusterCrcEnabled !== 'no') {
    return null;
  }
  return {
    id: 'cluster-crc-disabled',
    severity: 'warning',
    // Risky configuration with no observed symptom yet, so 'advisory' rather
    // than 'hazard' (which we reserve for confirmed dangerous state).
    status: 'advisory',
    message: CLUSTER_CRC_HAZARD_MESSAGE,
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
  /**
   * INFO persistence `aof_delayed_fsync`, or null when absent. Only meaningful
   * under `everysec` — the engine never increments it under `always`.
   */
  aofDelayedFsync: number | null;
  /**
   * Consecutive probes on which aof_delayed_fsync rose (service-computed across
   * probes). Evaluated for `everysec` only, for the same reason.
   */
  delayedFsyncRisingStreak: number;
  /** INFO persistence `aof_last_write_status`, or null when absent. */
  aofLastWriteStatus: string | null;
  /**
   * Event names from LATENCY LATEST whose latest spike is RECENT
   * (caller-filtered): entries persist until LATENCY RESET, so a stale spike
   * must not read as current blocking evidence. Empty when unsupported/clean.
   */
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
 * advisory; observed symptoms (an aof-* LATENCY event or a failing AOF write
 * status) escalate it to a confirmed hazard — NOT aof_delayed_fsync, which the
 * engine only increments under `everysec`.
 *
 * `everysec` is flagged only when aof_delayed_fsync climbs across at least two
 * consecutive probes — the once-per-second background fsync itself backing up
 * — never on config alone.
 */
export function evaluateAppendfsyncHazard(
  input: AppendfsyncHazardInput,
): ConfigHazardFinding | null {
  if (input.appendonly !== 'yes') {
    return null;
  }

  if (input.appendfsync === 'always') {
    // NOTE: aof_delayed_fsync is deliberately NOT a symptom here. The engine
    // only increments it in the everysec branch of flushAppendOnlyFile() —
    // under `always` the fsync is inline in the write path, so the counter
    // never moves and any escalation keyed on it would be unreachable.
    const symptoms: string[] = [];
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
