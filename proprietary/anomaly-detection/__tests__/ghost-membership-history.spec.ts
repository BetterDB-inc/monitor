import { ClusterNode } from '@app/common/types/metrics.types';
import { GhostMembershipHistory } from '../ghost-membership-history';

/** Build a minimal ClusterNode for tests. */
function node(partial: Partial<ClusterNode> & Pick<ClusterNode, 'id' | 'flags'>): ClusterNode {
  return {
    address: '10.0.0.1:6379@16379',
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 0,
    linkState: 'connected',
    slots: [],
    ...partial,
  };
}

const A = node({ id: 'nodeA', flags: ['myself', 'master'], address: '10.0.0.1:6379@16379' });
const B = node({ id: 'nodeB', flags: ['master'], address: '10.0.0.2:6379@16379' });
const C = node({ id: 'nodeC', flags: ['master'], address: '10.0.0.3:6379@16379' });

describe('GhostMembershipHistory', () => {
  let history: GhostMembershipHistory;
  let now: number;

  beforeEach(() => {
    history = new GhostMembershipHistory();
    now = 1_700_000_000_000;
  });

  /** Advance the clock and fold one observation in. Default step keeps a
   * two-poll absence just past the 60s FORGET blacklist window. */
  function observe(nodes: ClusterNode[], stepMs = 31_000) {
    now += stepMs;
    return history.observe(nodes, now);
  }

  it('fires when a departed id returns live after the minimum absence', () => {
    observe([A, B, C]);
    const departedAt = now + 31_000;
    observe([A, B]); // C removed by CLUSTER FORGET
    observe([A, B]);
    const findings = observe([A, B, C]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      nodeId: 'nodeC',
      endpoint: '10.0.0.3:6379',
      departedAt,
      absentPolls: 2,
    });
    expect(findings[0].returnedAt).toBe(now);
  });

  it('stays silent while the id is merely flagged fail — it never left the set', () => {
    observe([A, B, C]);
    observe([
      A,
      B,
      node({ id: 'nodeC', flags: ['master', 'fail'], address: '10.0.0.3:6379@16379' }),
    ]);
    observe([
      A,
      B,
      node({ id: 'nodeC', flags: ['master', 'fail'], address: '10.0.0.3:6379@16379' }),
    ]);
    observe([
      A,
      B,
      node({ id: 'nodeC', flags: ['master', 'noaddr'], address: '10.0.0.3:6379@16379' }),
    ]);
    const findings = observe([A, B, C]);

    expect(findings).toEqual([]);
  });

  it('stays silent for a brand-new node joining for the first time', () => {
    observe([A, B]);
    observe([A, B]);
    const findings = observe([A, B, C]);

    expect(findings).toEqual([]);
  });

  it('stays silent when the id returns inside the minimum absence window', () => {
    observe([A, B, C]);
    observe([A, B]); // absent for a single poll only
    const findings = observe([A, B, C]);

    expect(findings).toEqual([]);
  });

  it('does not age the absence while the id is back as a dead-twin line only', () => {
    observe([A, B, C]);
    observe([A, B]);
    observe([A, B]);
    // Re-enters the table, but only as a remembered dead identity.
    const whileGhost = observe([
      A,
      B,
      node({ id: 'nodeC', flags: ['master', 'fail'], address: '10.0.0.3:6379@16379' }),
    ]);
    expect(whileGhost).toEqual([]);

    const findings = observe([A, B, C]);
    expect(findings).toHaveLength(1);
    // Two absences, not three — the ghost-line poll did not count as absent.
    expect(findings[0].absentPolls).toBe(2);
  });

  it('fires once per rejoin, not on every subsequent poll', () => {
    observe([A, B, C]);
    observe([A, B]);
    observe([A, B]);
    expect(observe([A, B, C])).toHaveLength(1);
    expect(observe([A, B, C])).toEqual([]);
    expect(observe([A, B, C])).toEqual([]);
  });

  it('fires again when the same id is forgotten and reintroduces itself a second time', () => {
    observe([A, B, C]);
    observe([A, B]);
    observe([A, B]);
    expect(observe([A, B, C])).toHaveLength(1);

    observe([A, B]);
    observe([A, B]);
    expect(observe([A, B, C])).toHaveLength(1);
  });

  it('stays silent when the id returns faster than the FORGET blacklist window', () => {
    // Two polls of absence, but only ~2s of wall clock: a node cannot rejoin
    // inside the blacklist, so this is ordinary churn, not a self-reintroduction.
    observe([A, B, C]);
    observe([A, B], 1_000);
    observe([A, B], 1_000);
    expect(observe([A, B, C], 1_000)).toEqual([]);
  });

  it('fires once the absence exceeds both the poll count and the blacklist window', () => {
    observe([A, B, C]);
    observe([A, B], 1_000);
    observe([A, B], 1_000);
    const findings = observe([A, B, C], 90_000);

    expect(findings).toHaveLength(1);
    expect(findings[0].nodeId).toBe('nodeC');
  });

  it('treats a wiped view as a local CLUSTER RESET, not a mass FORGET', () => {
    // A CLUSTER RESET on the polled node drops every peer at once. Re-learning
    // them by gossip must not emit a forget-rejoin per peer.
    observe([A, B, C]);
    observe([A]);
    observe([A]);
    expect(observe([A, B, C], 90_000)).toEqual([]);
  });

  it('still reports a single removal from an otherwise intact view', () => {
    observe([A, B, C]);
    observe([A, B]);
    observe([A, B]);
    expect(observe([A, B, C], 90_000)).toHaveLength(1);
  });

  it('no-ops for a standalone single-node view', () => {
    expect(observe([A])).toEqual([]);
    expect(observe([A])).toEqual([]);
    expect(history.departedCount()).toBe(0);
  });

  it('forgets a departure once the retention window lapses, so a later return is a fresh join', () => {
    observe([A, B, C]);
    observe([A, B]);
    expect(history.departedCount()).toBe(1);

    // Well past the 6h retention window.
    observe([A, B], 7 * 60 * 60 * 1000);
    expect(history.departedCount()).toBe(0);

    expect(observe([A, B, C])).toEqual([]);
  });

  it('keeps the departed map bounded when ids churn through', () => {
    const many = Array.from({ length: 600 }, (_, i) => {
      return node({ id: `node${i}`, flags: ['master'], address: `10.1.0.${i % 250}:6379@16379` });
    });
    observe(many);

    // Two survivors, not one: a collapse to a single id reads as a view reset,
    // which discards every departure and would leave the ceiling untested.
    observe(many.slice(0, 2));

    expect(history.departedCount()).toBe(512);
  });
});
