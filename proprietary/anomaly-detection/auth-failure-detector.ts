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
 ## Three traps this module exists to avoid
 *
 * **Cumulative counts.** An `ACL LOG` entry is an aggregate: repeated failures
 * for the same user and reason bump one entry's `count` and its
 * `timestamp-last-updated`. The audit poller stores a NEW row whenever that
 * timestamp advances, so the same logical entry lands several times with a
 * growing cumulative count. Summing rows would multiply the real figure — the
 * rows for one entry must collapse to their maximum first. Note the entry
 * identity deliberately EXCLUDES `client-info`: the server overwrites that field
 * on every update of a matched entry, so keying on it would split one entry's
 * rows apart and reintroduce the very multiplication this guards against.
 *
 * **Ephemeral source ports.** Every connection attempt arrives from a different
 * source port, so `addr=1.2.3.4:53124` is unique per attempt. Aggregating on the
 * raw `addr` would put every failure in its own bucket and never cross a
 * threshold. The port is stripped and only the client IP is used as the key.
 *
 * **Lifetime counts are not window counts.** `count` is the entry's total since
 * it was created, which may be long before the window; and on a restart or a
 * newly-added connection the audit poller stores every entry currently in the
 * ring with `capturedAt` set to now, backfilling hours-old failures into what
 * looks like the present. Both are handled by windowing on the entry's OWN
 * timestamps and counting only the growth actually observed inside the window.
 *
 * ## A limit worth knowing
 *
 * The server groups ACL LOG entries by reason/context/object/username and does
 * NOT compare client addresses, so one entry's count can in principle span
 * several clients while `client-info` reflects only the most recent one. The
 * address is therefore reported as the client recorded against those failures,
 * not as a proven sole origin. It is the best attribution `ACL LOG` supports —
 * and far better than the aggregate counter, which has none at all.
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
 * poller stores as its count grows.
 *
 * These are exactly the fields the server itself matches on when deciding
 * whether a new failure joins an existing entry or starts a new one, plus the
 * creation timestamp. `client-info` is deliberately absent: the server replaces
 * it on every update, so including it would make our key FINER than the server's
 * own grouping and split one entry's rows into several.
 */
function entryKey(entry: StoredAclEntry): string {
  return [entry.timestampCreated, entry.username, entry.reason, entry.object].join('|');
}

/** One logical entry, collapsed from however many rows the poller stored for it. */
interface CollapsedEntry {
  /** The most recently stored row, whose `client-info` is the latest client seen. */
  latest: StoredAclEntry;
  /** Failures attributable to the window — see `collapse` for how this is derived. */
  windowCount: number;
}

/**
 * Collapses the rows of each logical entry and works out how much of its count
 * belongs inside the window.
 *
 * An entry CREATED inside the window contributes its whole count: every one of
 * its failures happened in the window. An older entry contributes only the growth
 * we actually observed across the rows stored in the window — its earlier total
 * accrued before the window opened and is not ours to report. An entry with no
 * activity in the window at all contributes nothing, which is what keeps a
 * restart backfill (every ring entry re-stored with `capturedAt` = now) from
 * reading as a fresh burst.
 */
function collapse(entries: StoredAclEntry[], windowStartMs: number): CollapsedEntry[] {
  const groups = new Map<string, StoredAclEntry[]>();
  for (const entry of entries) {
    const key = entryKey(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const collapsed: CollapsedEntry[] = [];
  for (const group of groups.values()) {
    const active = group.filter((entry) => {
      return entry.timestampLastUpdated >= windowStartMs;
    });
    if (active.length === 0) {
      continue;
    }

    const counts = active.map((entry) => {
      return Number.isFinite(entry.count) ? entry.count : 0;
    });
    const maxCount = Math.max(...counts);
    const latest = active.reduce((newest, entry) => {
      return entry.timestampLastUpdated >= newest.timestampLastUpdated ? entry : newest;
    });

    const bornInWindow = latest.timestampCreated >= windowStartMs;
    const windowCount = bornInWindow ? maxCount : maxCount - Math.min(...counts);
    if (windowCount <= 0) {
      continue;
    }
    collapsed.push({ latest, windowCount });
  }

  return collapsed;
}

/**
 * Collapses stored rows into per-client-IP totals and returns the addresses over
 * the failure threshold, worst first. Pure: the caller supplies the window.
 */
export function detectAuthFailureBursts(
  entries: StoredAclEntry[],
  windowStartMs: number,
  minCount: number = AUTH_FAILURE_MIN_COUNT,
): AuthFailureSource[] {
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

  for (const { latest: entry, windowCount } of collapse(entries, windowStartMs)) {
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

    const count = windowCount;
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
