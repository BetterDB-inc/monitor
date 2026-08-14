import { StoredAclEntry } from '@betterdb/shared';
import {
  AUTH_FAILURE_ALERT_COOLDOWN_MS,
  clientAddressFrom,
  createAuthFailureState,
  detectAuthFailureBursts,
  takeAlertable,
} from '../auth-failure-detector';

let nextCreated = 1_000;

function entry(partial: Partial<StoredAclEntry> = {}): StoredAclEntry {
  nextCreated += 1;
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
    capturedAt: 1_700_000_000,
    sourceHost: '10.0.0.1',
    sourcePort: 6379,
    connectionId: 'conn-1',
    ...partial,
  };
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

    const [source] = detectAuthFailureBursts(entries);
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

    expect(detectAuthFailureBursts(entries)).toEqual([]);
  });

  it('collapses the repeated rows of one growing entry instead of summing them', () => {
    // The audit poller re-stores an entry every time its cumulative count grows.
    const created = 5_000;
    const rows = [3, 7, 15].map((count) => {
      return entry({ count, timestampCreated: created, timestampLastUpdated: created + count });
    });

    const [source] = detectAuthFailureBursts(rows);
    expect(source.authFailures).toBe(15);
  });

  it('keeps genuinely distinct entries from the same address separate', () => {
    const rows = [
      entry({ count: 6, timestampCreated: 1 }),
      entry({ count: 6, timestampCreated: 2 }),
    ];

    const [source] = detectAuthFailureBursts(rows);
    expect(source.authFailures).toBe(12);
  });

  it('aggregates a brute-force spread across many ephemeral source ports', () => {
    const rows = Array.from({ length: 12 }, (_, i) => {
      return entry({ clientInfo: `id=${i} addr=203.0.113.9:${50000 + i} fd=${i}` });
    });

    const [source] = detectAuthFailureBursts(rows);
    expect(source.authFailures).toBe(12);
    expect(source.clientAddress).toBe('203.0.113.9');
  });

  it('counts only auth failures toward the threshold but reports every reason', () => {
    const rows = [
      entry({ count: 4, reason: 'auth' }),
      entry({ count: 40, reason: 'command', object: 'FLUSHALL' }),
      entry({ count: 9, reason: 'key', object: 'secret:*' }),
    ];

    expect(detectAuthFailureBursts(rows)).toEqual([]);

    const withEnoughAuth = [...rows, entry({ count: 8, reason: 'auth' })];
    const [source] = detectAuthFailureBursts(withEnoughAuth);
    expect(source.authFailures).toBe(12);
    expect(source.reasonBreakdown).toEqual({ auth: 12, command: 40, key: 9 });
  });

  it('ranks the worst offender first', () => {
    const rows = [
      entry({ count: 11, clientInfo: 'addr=198.51.100.4:1111' }),
      entry({ count: 40, clientInfo: 'addr=203.0.113.9:2222' }),
    ];

    const sources = detectAuthFailureBursts(rows);
    expect(sources.map((s) => s.clientAddress)).toEqual(['203.0.113.9', '198.51.100.4']);
  });

  it('skips entries with no parseable client address rather than bucketing them together', () => {
    const rows = Array.from({ length: 20 }, () => {
      return entry({ clientInfo: 'id=1 fd=8 name=' });
    });

    expect(detectAuthFailureBursts(rows)).toEqual([]);
  });

  it('handles an empty window and a non-numeric count without throwing', () => {
    expect(detectAuthFailureBursts([])).toEqual([]);
    expect(detectAuthFailureBursts([entry({ count: NaN })])).toEqual([]);
  });
});

describe('takeAlertable', () => {
  it('alerts once per address, then holds off for the cooldown', () => {
    const state = createAuthFailureState();
    const sources = detectAuthFailureBursts([entry({ count: 20 })]);
    const now = 1_700_000_000_000;

    expect(takeAlertable(state, sources, now)).toHaveLength(1);
    expect(takeAlertable(state, sources, now + 60_000)).toEqual([]);
    expect(takeAlertable(state, sources, now + AUTH_FAILURE_ALERT_COOLDOWN_MS + 1)).toHaveLength(1);
  });

  it('alerts a second address immediately while the first is still cooling down', () => {
    const state = createAuthFailureState();
    const now = 1_700_000_000_000;
    const first = detectAuthFailureBursts([entry({ count: 20 })]);
    const second = detectAuthFailureBursts([
      entry({ count: 20, clientInfo: 'addr=198.51.100.4:1111' }),
    ]);

    expect(takeAlertable(state, first, now)).toHaveLength(1);
    expect(takeAlertable(state, second, now + 1_000)).toHaveLength(1);
  });

  it('prunes cooldown entries once they lapse so the map stays bounded', () => {
    const state = createAuthFailureState();
    const now = 1_700_000_000_000;
    takeAlertable(state, detectAuthFailureBursts([entry({ count: 20 })]), now);
    expect(state.lastAlertedAt.size).toBe(1);

    takeAlertable(state, [], now + AUTH_FAILURE_ALERT_COOLDOWN_MS + 1);
    expect(state.lastAlertedAt.size).toBe(0);
  });
});
