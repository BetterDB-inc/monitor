import { StoredAclEntry } from '@betterdb/shared';
import {
  AUTH_FAILURE_ALERT_COOLDOWN_MS,
  AUTH_FAILURE_WINDOW_MS,
  AuthFailureState,
  clientAddressFrom,
  createAuthFailureState,
  observeAuthFailures,
  takeAlertable,
} from '../auth-failure-detector';

const NOW = 1_700_000_000_000;
const WINDOW_START = NOW - 5 * 60 * 1000;

let nextCreated = NOW - 120_000;

function entry(partial: Partial<StoredAclEntry> = {}): StoredAclEntry {
  // Distinct creation stamps by default, all comfortably inside the window.
  nextCreated += 1_000;
  return {
    id: 0,
    count: 1,
    reason: 'auth',
    context: 'toplevel',
    object: 'AUTH',
    username: 'default',
    ageSeconds: 1,
    clientInfo: 'id=7 addr=203.0.113.9:51234 laddr=10.0.0.1:6379 fd=8 name= age=0',
    timestampCreated: nextCreated,
    timestampLastUpdated: nextCreated,
    capturedAt: Math.floor(NOW / 1000),
    sourceHost: '10.0.0.1',
    sourcePort: 6379,
    connectionId: 'conn-1',
    ...partial,
  };
}

/**
 * One scan against a fresh state. The store upserts one row per logical entry,
 * so a first sighting only baselines an entry created before the window — tests
 * that need growth must scan twice (see `scanTwice`).
 */
function burst(entries: StoredAclEntry[], minCount?: number) {
  return observeAuthFailures(
    createAuthFailureState(),
    entries,
    NOW,
    AUTH_FAILURE_WINDOW_MS,
    minCount,
  );
}

/** Two scans a minute apart, returning the second scan's sources. */
function scanTwice(first: StoredAclEntry[], second: StoredAclEntry[], minCount?: number) {
  const state = createAuthFailureState();
  observeAuthFailures(state, first, NOW - 60_000, AUTH_FAILURE_WINDOW_MS, minCount);
  return observeAuthFailures(state, second, NOW, AUTH_FAILURE_WINDOW_MS, minCount);
}

describe('clientAddressFrom', () => {
  it('strips the ephemeral source port so attempts aggregate per IP', () => {
    expect(clientAddressFrom('id=7 addr=203.0.113.9:51234 fd=8')).toBe('203.0.113.9');
    expect(clientAddressFrom('id=8 addr=203.0.113.9:60001 fd=9')).toBe('203.0.113.9');
  });

  it('unwraps a bracketed IPv6 address', () => {
    expect(clientAddressFrom('id=7 addr=[2001:db8::1]:51234 fd=8')).toBe('2001:db8::1');
    expect(clientAddressFrom('id=7 addr=[::1]:6379 fd=8')).toBe('::1');
  });

  it('returns empty when there is no usable addr field', () => {
    expect(clientAddressFrom('id=7 fd=8 name=')).toBe('');
    expect(clientAddressFrom('')).toBe('');
  });

  it('does not match a field that merely ends in addr', () => {
    expect(clientAddressFrom('id=7 laddr=10.0.0.1:6379 fd=8')).toBe('');
  });
});

describe('detectAuthFailureBursts', () => {
  it('fires for a single address over the threshold and names the usernames', () => {
    const entries = [entry({ count: 8, username: 'admin' }), entry({ count: 5, username: 'root' })];

    const [source] = burst(entries);
    expect(source.clientAddress).toBe('203.0.113.9');
    expect(source.authFailures).toBe(13);
    expect(source.usernames).toEqual(['admin', 'root']);
  });

  it('stays silent for scattered failures under the threshold', () => {
    const entries = [
      entry({ count: 2 }),
      entry({ count: 3, clientInfo: 'addr=198.51.100.4:1111' }),
      entry({ count: 1, clientInfo: 'addr=198.51.100.5:2222' }),
    ];

    expect(burst(entries)).toEqual([]);
  });

  it('counts an entry created inside the window in full on first sighting', () => {
    const created = NOW - 60_000;
    const rows = [entry({ count: 15, timestampCreated: created, timestampLastUpdated: created })];

    const [source] = burst(rows);
    expect(source.authFailures).toBe(15);
  });

  it('accumulates growth of a long-lived entry across scans', () => {
    // The store upserts one row per entry, so the count is rewritten in place.
    // Only the growth we observe belongs to the window.
    const created = NOW - 60 * 60 * 1000;
    const before = [
      entry({ count: 40, timestampCreated: created, timestampLastUpdated: NOW - 60_000 }),
    ];
    const after = [entry({ count: 55, timestampCreated: created, timestampLastUpdated: NOW })];

    const [source] = scanTwice(before, after, 10);
    expect(source.authFailures).toBe(15);
  });

  it('keeps accumulating a sustained attack across several scans', () => {
    // Four failures per scan is under the threshold on its own; over the window
    // it is a burst. A per-scan delta alone would never fire.
    const created = NOW - 60 * 60 * 1000;
    const state = createAuthFailureState();
    let last: ReturnType<typeof observeAuthFailures> = [];
    for (let scan = 0; scan <= 4; scan++) {
      last = observeAuthFailures(
        state,
        [entry({ count: 100 + scan * 4, timestampCreated: created, timestampLastUpdated: NOW })],
        NOW - 120_000 + scan * 30_000,
        AUTH_FAILURE_WINDOW_MS,
        10,
      );
    }
    expect(last[0].authFailures).toBe(16);
  });

  it('baselines rather than counting when an old entry is first seen', () => {
    // A restart re-saves every ring entry; their lifetime totals are not ours.
    const created = NOW - 4 * 60 * 60 * 1000;
    const rows = [entry({ count: 500, timestampCreated: created, timestampLastUpdated: created })];

    expect(burst(rows)).toEqual([]);
  });

  it('absorbs an ACL LOG RESET without producing a negative delta', () => {
    const created = NOW - 60 * 60 * 1000;
    const before = [entry({ count: 500, timestampCreated: created })];
    const after = [entry({ count: 2, timestampCreated: created })];

    expect(scanTwice(before, after, 1)).toEqual([]);
  });

  it('prunes bookkeeping for entries that fall out of the ring', () => {
    const state: AuthFailureState = createAuthFailureState();
    observeAuthFailures(state, [entry({ count: 5 })], NOW, AUTH_FAILURE_WINDOW_MS);
    expect(state.lastCount.size).toBe(1);

    observeAuthFailures(state, [], NOW + AUTH_FAILURE_WINDOW_MS * 5, AUTH_FAILURE_WINDOW_MS);
    expect(state.lastCount.size).toBe(0);
    expect(state.deltas.size).toBe(0);
  });

  it('ignores entries whose activity predates the window', () => {
    // A restart re-saves every ring entry with capturedAt = now, backfilling
    // hours-old failures. Their own timestamps still say they are old.
    const old = NOW - 4 * 60 * 60 * 1000;
    const rows = [
      entry({
        count: 500,
        timestampCreated: old,
        timestampLastUpdated: old,
        capturedAt: Math.floor(NOW / 1000),
      }),
    ];

    expect(burst(rows)).toEqual([]);
  });

  it('keeps genuinely distinct entries from the same address separate', () => {
    const rows = [
      entry({ count: 6, timestampCreated: NOW - 90_000, timestampLastUpdated: NOW - 80_000 }),
      entry({ count: 6, timestampCreated: NOW - 70_000, timestampLastUpdated: NOW - 60_000 }),
    ];

    const [source] = burst(rows);
    expect(source.authFailures).toBe(12);
  });

  it('aggregates a brute-force spread across many ephemeral source ports', () => {
    const rows = Array.from({ length: 12 }, (_, i) => {
      return entry({ clientInfo: `id=${i} addr=203.0.113.9:${50000 + i} fd=${i}` });
    });

    const [source] = burst(rows);
    expect(source.authFailures).toBe(12);
    expect(source.clientAddress).toBe('203.0.113.9');
  });

  it('counts only auth failures toward the threshold but reports every reason', () => {
    const rows = [
      entry({ count: 4, reason: 'auth' }),
      entry({ count: 40, reason: 'command', object: 'FLUSHALL' }),
      entry({ count: 9, reason: 'key', object: 'secret:*' }),
    ];

    expect(burst(rows)).toEqual([]);

    const withEnoughAuth = [...rows, entry({ count: 8, reason: 'auth' })];
    const [source] = burst(withEnoughAuth);
    expect(source.authFailures).toBe(12);
    expect(source.reasonBreakdown).toEqual({ auth: 12, command: 40, key: 9 });
  });

  it('ranks the worst offender first', () => {
    const rows = [
      entry({ count: 11, clientInfo: 'addr=198.51.100.4:1111' }),
      entry({ count: 40, clientInfo: 'addr=203.0.113.9:2222' }),
    ];

    const sources = burst(rows);
    expect(sources.map((s) => s.clientAddress)).toEqual(['203.0.113.9', '198.51.100.4']);
  });

  it('skips entries with no parseable client address rather than bucketing them together', () => {
    const rows = Array.from({ length: 20 }, () => {
      return entry({ clientInfo: 'id=1 fd=8 name=' });
    });

    expect(burst(rows)).toEqual([]);
  });

  it('handles an empty window and a non-numeric count without throwing', () => {
    expect(burst([])).toEqual([]);
    expect(burst([entry({ count: NaN })])).toEqual([]);
  });
});

describe('takeAlertable', () => {
  it('alerts once per address, then holds off for the cooldown', () => {
    const state = createAuthFailureState();
    const sources = burst([entry({ count: 20 })]);
    const now = 1_700_000_000_000;

    expect(takeAlertable(state, sources, now)).toHaveLength(1);
    expect(takeAlertable(state, sources, now + 60_000)).toEqual([]);
    expect(takeAlertable(state, sources, now + AUTH_FAILURE_ALERT_COOLDOWN_MS + 1)).toHaveLength(1);
  });

  it('alerts a second address immediately while the first is still cooling down', () => {
    const state = createAuthFailureState();
    const now = 1_700_000_000_000;
    const first = burst([entry({ count: 20 })]);
    const second = burst([entry({ count: 20, clientInfo: 'addr=198.51.100.4:1111' })]);

    expect(takeAlertable(state, first, now)).toHaveLength(1);
    expect(takeAlertable(state, second, now + 1_000)).toHaveLength(1);
  });

  it('prunes cooldown entries once they lapse so the map stays bounded', () => {
    const state = createAuthFailureState();
    const now = 1_700_000_000_000;
    takeAlertable(state, burst([entry({ count: 20 })]), now);
    expect(state.lastAlertedAt.size).toBe(1);

    takeAlertable(state, [], now + AUTH_FAILURE_ALERT_COOLDOWN_MS + 1);
    expect(state.lastAlertedAt.size).toBe(0);
  });
});

describe('entry identity', () => {
  it('keeps entries that differ only by context apart', () => {
    const state = createAuthFailureState();
    const now = 1_700_000_000_000;
    const base = {
      timestampCreated: now - 1_000,
      username: 'app',
      reason: 'auth',
      object: 'AUTH',
      clientInfo: 'addr=10.0.0.1:5000',
    };

    // Same user, same reason, same object — different context. The server treats
    // these as two entries, so their counts must not be merged into one key.
    observeAuthFailures(
      state,
      [
        entry({ ...base, context: 'toplevel', count: 5 }),
        entry({ ...base, context: 'lua', count: 5 }),
      ],
      now,
    );

    const sources = observeAuthFailures(
      state,
      [
        entry({ ...base, context: 'toplevel', count: 11 }),
        entry({ ...base, context: 'lua', count: 5 }),
      ],
      now + 1_000,
    );

    // Two distinct keys are tracked, one per context. Sharing a key would leave
    // one, and would mis-state the growth: the second row's lower count against the
    // first row's baseline clamps to 0, losing 5 of the 16 observed failures.
    expect(state.deltas.size).toBe(2);
    expect(sources).toHaveLength(1);
    expect(sources[0].authFailures).toBe(16);
  });
});
