import { StoredAclEntry } from '@betterdb/shared';
import {
  AUTH_FAILURE_ALERT_COOLDOWN_MS,
  clientAddressFrom,
  createAuthFailureState,
  detectAuthFailureBursts,
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

/** detectAuthFailureBursts against the standard 5-minute window. */
function burst(entries: StoredAclEntry[], minCount?: number) {
  return detectAuthFailureBursts(entries, WINDOW_START, minCount);
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

  it('collapses the repeated rows of one growing entry instead of summing them', () => {
    // The audit poller re-stores an entry every time its cumulative count grows.
    const created = NOW - 60_000;
    const rows = [3, 7, 15].map((count) => {
      return entry({ count, timestampCreated: created, timestampLastUpdated: created + count });
    });

    const [source] = burst(rows);
    expect(source.authFailures).toBe(15);
  });

  it('still collapses when the server rewrote client-info between updates', () => {
    // The server replaces an entry's client-info on every update, so the source
    // port differs between rows of the SAME logical entry. Keying on client-info
    // would split them apart and sum 3 + 7 + 15 into 25.
    const created = NOW - 60_000;
    const rows = [3, 7, 15].map((count, i) => {
      return entry({
        count,
        timestampCreated: created,
        timestampLastUpdated: created + count,
        clientInfo: `id=${i} addr=203.0.113.9:${51000 + i * 7} fd=${i}`,
      });
    });

    const [source] = burst(rows);
    expect(source.authFailures).toBe(15);
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

  it('counts only the growth observed in-window for an entry born earlier', () => {
    const old = NOW - 60 * 60 * 1000;
    const rows = [40, 47, 55].map((count, i) => {
      return entry({
        count,
        timestampCreated: old,
        timestampLastUpdated: NOW - 120_000 + i * 1_000,
      });
    });

    // 55 total, but only 15 of them accrued while we were watching this window.
    const [source] = burst(rows, 10);
    expect(source.authFailures).toBe(15);
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
