import { StoredAclEntry } from '@betterdb/shared';

/**
 * Authentication-failure / brute-force advisory (valkey-io/valkey#334).
 *
 * Operators want to know when a specific client IP is hammering the server with
 * bad credentials — not just that the aggregate `acl_access_denied_auth` counter
 * ticked up. Upstream #334 asks for auth failures logged with the client address;
 * the richer additions discussed there (metric subcommands, an audit-log file)
 * have not shipped and the feature is deferred, but `ACL LOG` already carries
 * everything needed: reason, username, client-info, and a per-entry count.
 *
 * We do not poll `ACL LOG` here. `AuditService` already polls it every cycle,
 * dedupes it, and persists it, so this advisory reads the audit store instead —
 * one fetch of a signal, not two.
 *
 * ## Two traps this module exists to avoid
 *
 * **Cumulative counts.** An `ACL LOG` entry is an aggregate: repeated failures
 * from the same client for the same reason bump one entry's `count` and its
 * `timestamp-last-updated`. The audit poller stores a NEW row whenever that
 * timestamp advances, so the same logical entry lands several times with a
 * growing cumulative count. Summing rows would multiply the real figure — the
 * rows for one entry must collapse to their maximum first.
 *
 * **Ephemeral source ports.** Every connection attempt arrives from a different
 * source port, so `addr=1.2.3.4:53124` is unique per attempt. Aggregating on the
 * raw `addr` would put every failure in its own bucket and never cross a
 * threshold. The port is stripped and only the client IP is used as the key.
 */

/** Rolling window over which failures from one address are accumulated. */
export const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;

/** Auth failures from a single client IP inside the window before the advisory fires. */
export const AUTH_FAILURE_MIN_COUNT = 10;

/**
 * Minimum gap between alerts for the same client IP, so an attack that runs for
 * an hour produces a handful of findings rather than one per poll.
 */
export const AUTH_FAILURE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Row ceiling for the audit-store window query. The store defaults to 100, which
 * a noisy log would silently truncate — and a truncated window under-counts
 * exactly when the advisory matters most.
 */
export const AUTH_FAILURE_QUERY_LIMIT = 2000;

/** `ACL LOG` reason for a failed authentication, as opposed to a denied command/key/channel. */
const AUTH_REASON = 'auth';

export interface AuthFailureSource {
  /** Offending client IP, with the ephemeral source port stripped. */
  clientAddress: string;
  /** Auth failures attributed to this address inside the window. */
  authFailures: number;
  /** Usernames the address attempted, most-attempted first. */
  usernames: string[];
  /** Every ACL LOG reason seen from this address in the window, with counts. */
  reasonBreakdown: Record<string, number>;
  /** Epoch seconds of the earliest and latest capture in the window. */
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface AuthFailureState {
  /** Client IP → epoch ms of the last alert, for the per-address cooldown. */
  lastAlertedAt: Map<string, number>;
}

export function createAuthFailureState(): AuthFailureState {
  return { lastAlertedAt: new Map() };
}

/**
 * Client IP from an ACL LOG `client-info` line, or '' when it has no usable
 * `addr=` field. The trailing `:port` is dropped — it is a different ephemeral
 * port on every attempt — and IPv6 brackets are unwrapped.
 */
export function clientAddressFrom(clientInfo: string): string {
  const match = /(?:^|\s)addr=(\S+)/.exec(clientInfo ?? '');
  if (match === null) {
    return '';
  }

  const addr = match[1];
  const bracketed = /^\[(.+)\]:\d+$/.exec(addr);
  if (bracketed !== null) {
    return bracketed[1];
  }

  const portColon = addr.lastIndexOf(':');
  if (portColon === -1) {
    return addr;
  }
  return addr.slice(0, portColon);
}

/**
 * Identity of one logical `ACL LOG` entry across the several rows the audit
 * poller stores as its count grows. `timestampCreated` is stable for the life of
 * an entry; pairing it with the user, client and reason makes collisions between
 * genuinely distinct entries implausible.
 */
function entryKey(entry: StoredAclEntry): string {
  return [entry.timestampCreated, entry.username, entry.clientInfo, entry.reason].join('|');
}

/**
 * Collapses stored rows into per-client-IP totals and returns the addresses over
 * the failure threshold, worst first. Pure: all windowing is the caller's job.
 */
export function detectAuthFailureBursts(
  entries: StoredAclEntry[],
  minCount: number = AUTH_FAILURE_MIN_COUNT,
): AuthFailureSource[] {
  // Collapse the repeated rows of one logical entry to its highest count.
  const byEntry = new Map<string, StoredAclEntry>();
  for (const entry of entries) {
    const key = entryKey(entry);
    const existing = byEntry.get(key);
    if (existing === undefined || entry.count > existing.count) {
      byEntry.set(key, entry);
    }
  }

  const byAddress = new Map<
    string,
    {
      authFailures: number;
      usernames: Map<string, number>;
      reasonBreakdown: Record<string, number>;
      firstSeenAt: number;
      lastSeenAt: number;
    }
  >();

  for (const entry of byEntry.values()) {
    const address = clientAddressFrom(entry.clientInfo);
    if (address === '') {
      continue;
    }

    const bucket = byAddress.get(address) ?? {
      authFailures: 0,
      usernames: new Map<string, number>(),
      reasonBreakdown: {},
      firstSeenAt: entry.capturedAt,
      lastSeenAt: entry.capturedAt,
    };

    const count = Number.isFinite(entry.count) ? entry.count : 0;
    bucket.reasonBreakdown[entry.reason] = (bucket.reasonBreakdown[entry.reason] ?? 0) + count;
    if (entry.reason === AUTH_REASON) {
      bucket.authFailures += count;
      bucket.usernames.set(entry.username, (bucket.usernames.get(entry.username) ?? 0) + count);
    }
    bucket.firstSeenAt = Math.min(bucket.firstSeenAt, entry.capturedAt);
    bucket.lastSeenAt = Math.max(bucket.lastSeenAt, entry.capturedAt);

    byAddress.set(address, bucket);
  }

  const sources: AuthFailureSource[] = [];
  for (const [clientAddress, bucket] of byAddress) {
    if (bucket.authFailures < minCount) {
      continue;
    }
    sources.push({
      clientAddress,
      authFailures: bucket.authFailures,
      usernames: [...bucket.usernames.entries()]
        .sort((a, b) => {
          return b[1] - a[1];
        })
        .map(([username]) => {
          return username;
        }),
      reasonBreakdown: bucket.reasonBreakdown,
      firstSeenAt: bucket.firstSeenAt,
      lastSeenAt: bucket.lastSeenAt,
    });
  }

  return sources.sort((a, b) => {
    return b.authFailures - a.authFailures;
  });
}

/**
 * Filters findings down to those not alerted inside the cooldown, stamping the
 * ones that pass. Also prunes stale cooldown entries so the map cannot grow with
 * every address that ever misbehaved.
 */
export function takeAlertable(
  state: AuthFailureState,
  sources: AuthFailureSource[],
  now: number,
  cooldownMs: number = AUTH_FAILURE_ALERT_COOLDOWN_MS,
): AuthFailureSource[] {
  for (const [address, alertedAt] of state.lastAlertedAt) {
    if (now - alertedAt <= cooldownMs) {
      continue;
    }
    state.lastAlertedAt.delete(address);
  }

  const alertable: AuthFailureSource[] = [];
  for (const source of sources) {
    const alertedAt = state.lastAlertedAt.get(source.clientAddress);
    if (alertedAt !== undefined && now - alertedAt <= cooldownMs) {
      continue;
    }
    state.lastAlertedAt.set(source.clientAddress, now);
    alertable.push(source);
  }
  return alertable;
}
