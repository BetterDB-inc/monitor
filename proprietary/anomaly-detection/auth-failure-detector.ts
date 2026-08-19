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
 * looks like the present.
 *
 * The store makes this sharper still: `saveAclEntries` UPSERTS on
 * (timestamp_created, username, object, reason, …), so one logical entry is
 * exactly one row whose `count` is rewritten in place. There is no row history to
 * difference. In-window activity is therefore tracked the same way every other
 * cumulative counter in this service is: remember each entry's count from the
 * previous scan and accumulate the per-scan GROWTH across the window.
 *
 * ## A limit worth knowing
 *
 * The server groups ACL LOG entries by reason/context/object/username and does
 * NOT compare client addresses, so one entry's count can span several clients
 * while `client-info` reflects only the most recent one — and the store refreshes
 * that column on every upsert, so it really is the latest client, not the first.
 *
 * Read the reported address as "the client last seen against these failures",
 * never as a proven sole origin. Two concrete consequences, because this advisory
 * NAMES AN IP and an operator may act on it:
 *
 *   - Two attackers hitting one username merge into a single entry, and all the
 *     growth is attributed to whichever of them wrote last.
 *   - Attribution can FLIP between scans. With the per-address alert cooldown,
 *     that surfaces as repeat advisories for the same underlying activity naming
 *     different IPs — not as evidence of a second, distinct attack.
 *
 * Confirm against the raw `ACL LOG` before blocking an address. It is still the
 * best attribution `ACL LOG` supports, and far better than the aggregate counter,
 * which has none at all.
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
}

export interface AuthFailureState {
  /** Client IP → epoch ms of the last alert, for the per-address cooldown. */
  lastAlertedAt: Map<string, number>;
  /** Entry key → its `count` at the previous scan. */
  lastCount: Map<string, number>;
  /** Entry key → the per-scan growth still inside the window. */
  deltas: Map<string, DeltaSample[]>;
  /** Entry key → when it was last present in the store, for pruning. */
  lastSeenAt: Map<string, number>;
}

export function createAuthFailureState(): AuthFailureState {
  return {
    lastAlertedAt: new Map(),
    lastCount: new Map(),
    deltas: new Map(),
    lastSeenAt: new Map(),
  };
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
 * The server's own grouping (`ACLLogMatchEntry`) matches on reason, context,
 * object, username and a creation time within a grouping delta, so all five
 * appear here. `context` was previously missing, which made this key COARSER than
 * the server's: two entries that differ only by context — the same user denied at
 * the top level and inside a Lua script, say — collapsed into one key and had
 * their counts merged.
 *
 * `client-info` is deliberately absent: the server replaces it on every update, so
 * including it would make the key FINER than the server's grouping and split one
 * entry's rows into several.
 *
 * The timestamp is compared exactly here while the server allows a small delta.
 * That is harmless — a grouped entry keeps the creation time of its first failure,
 * so its rows all carry the same value.
 */
function entryKey(entry: StoredAclEntry): string {
  return [entry.timestampCreated, entry.username, entry.reason, entry.context, entry.object].join(
    '|',
  );
}

/** Per-scan growth of one entry, kept only as long as the window needs it. */
interface DeltaSample {
  at: number;
  delta: number;
}

/**
 * Folds one scan of the audit store into the state and returns each entry's
 * failures within the window.
 *
 * The first sighting of an entry sets a baseline rather than counting: an entry
 * created before the window opened has a lifetime total that is not ours to
 * report, and a restart backfill is exactly that case for every entry in the
 * ring. An entry created INSIDE the window is different — all of its failures are
 * recent, so its whole count lands at once.
 */
function accumulate(
  state: AuthFailureState,
  entries: StoredAclEntry[],
  now: number,
  windowMs: number,
): Array<{ entry: StoredAclEntry; windowCount: number }> {
  const windowStart = now - windowMs;
  const results: Array<{ entry: StoredAclEntry; windowCount: number }> = [];

  for (const entry of entries) {
    const key = entryKey(entry);
    const count = Number.isFinite(entry.count) ? entry.count : 0;
    const previous = state.lastCount.get(key);

    let delta: number;
    if (previous === undefined) {
      delta = entry.timestampCreated >= windowStart ? count : 0;
    } else {
      // max(0, …) absorbs an ACL LOG RESET or a ring eviction that restarts the
      // entry at a lower count.
      delta = Math.max(0, count - previous);
    }
    state.lastCount.set(key, count);
    state.lastSeenAt.set(key, now);

    const samples = state.deltas.get(key) ?? [];
    if (delta > 0) {
      samples.push({ at: now, delta });
    }
    const inWindow = samples.filter((sample) => {
      return sample.at > windowStart;
    });
    if (inWindow.length > 0) {
      state.deltas.set(key, inWindow);
    } else {
      state.deltas.delete(key);
    }

    const windowCount = inWindow.reduce((total, sample) => {
      return total + sample.delta;
    }, 0);
    if (windowCount > 0) {
      results.push({ entry, windowCount });
    }
  }

  return results;
}

/** Drops per-entry bookkeeping for entries that have fallen out of the ring. */
function pruneState(state: AuthFailureState, now: number, windowMs: number): void {
  const cutoff = now - windowMs * 4;
  for (const [key, seenAt] of state.lastSeenAt) {
    if (seenAt > cutoff) {
      continue;
    }
    state.lastSeenAt.delete(key);
    state.lastCount.delete(key);
    state.deltas.delete(key);
  }
}

/**
 * Folds one scan into the state and returns the client addresses over the
 * failure threshold within the window, worst first.
 */
export function observeAuthFailures(
  state: AuthFailureState,
  entries: StoredAclEntry[],
  now: number,
  windowMs: number = AUTH_FAILURE_WINDOW_MS,
  minCount: number = AUTH_FAILURE_MIN_COUNT,
): AuthFailureSource[] {
  const byAddress = new Map<
    string,
    {
      authFailures: number;
      usernames: Map<string, number>;
      reasonBreakdown: Record<string, number>;
    }
  >();

  for (const { entry, windowCount } of accumulate(state, entries, now, windowMs)) {
    const address = clientAddressFrom(entry.clientInfo);
    if (address === '') {
      continue;
    }

    const bucket = byAddress.get(address) ?? {
      authFailures: 0,
      usernames: new Map<string, number>(),
      reasonBreakdown: {},
    };

    const count = windowCount;
    bucket.reasonBreakdown[entry.reason] = (bucket.reasonBreakdown[entry.reason] ?? 0) + count;
    if (entry.reason === AUTH_REASON) {
      bucket.authFailures += count;
      bucket.usernames.set(entry.username, (bucket.usernames.get(entry.username) ?? 0) + count);
    }

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
    });
  }

  pruneState(state, now, windowMs);

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
