import {
  REPLICATION_RATE_EWMA_ALPHA,
  ReplicationStreamTracker,
  parseReplicaLines,
} from '../replication-stream';

const T0 = 1_700_000_000_000;
const REPLID_A = 'a'.repeat(40);
const REPLID_B = 'b'.repeat(40);

function primaryInfo(over: Record<string, string> = {}): Record<string, string> {
  return {
    role: 'master',
    connected_slaves: '2',
    master_replid: REPLID_A,
    master_replid2: '0'.repeat(40),
    master_repl_offset: '10000',
    repl_backlog_size: '8000',
    repl_backlog_histlen: '100',
    slave0: 'ip=10.0.0.2,port=6379,state=online,offset=9000,lag=0',
    slave1: 'ip=10.0.0.3,port=6380,state=online,offset=10000,lag=1',
    ...over,
  };
}

describe('parseReplicaLines', () => {
  it('parses every slaveN line into an offset observation', () => {
    expect(parseReplicaLines(primaryInfo())).toEqual([
      { key: 'slave0', addr: '10.0.0.2:6379', state: 'online', offset: 9000, lagSec: 0 },
      { key: 'slave1', addr: '10.0.0.3:6380', state: 'online', offset: 10000, lagSec: 1 },
    ]);
  });

  it('skips malformed lines and keys that only look like slaveN', () => {
    const info = primaryInfo({
      slave2: 'garbage',
      slave3: 'ip=10.0.0.4,port=6379,state=online,offset=abc,lag=0',
      slave_repl_offset: '42',
      slave_read_only: '1',
    });
    expect(parseReplicaLines(info).map((r) => r.key)).toEqual(['slave0', 'slave1']);
  });

  it('reports a null lag when the field is missing', () => {
    const info = { slave0: 'ip=10.0.0.2,port=6379,state=wait_bgsave,offset=0' };
    expect(parseReplicaLines(info)).toEqual([
      { key: 'slave0', addr: '10.0.0.2:6379', state: 'wait_bgsave', offset: 0, lagSec: null },
    ]);
  });

  it('orders replicas by index, not by key string order', () => {
    const info = {
      slave10: 'ip=h10,port=1,state=online,offset=1,lag=0',
      slave2: 'ip=h2,port=1,state=online,offset=1,lag=0',
    };
    expect(parseReplicaLines(info).map((r) => r.key)).toEqual(['slave2', 'slave10']);
  });
});

describe('ReplicationStreamTracker', () => {
  it('returns null when the node reports no master_repl_offset', () => {
    const tracker = new ReplicationStreamTracker();
    expect(tracker.observe('c1', { role: 'master' }, T0)).toBeNull();
    expect(tracker.latest('c1')).toBeNull();
  });

  it('computes the per-replica gap, clamped at zero', () => {
    const tracker = new ReplicationStreamTracker();
    const sample = tracker.observe(
      'c1',
      primaryInfo({ slave1: 'ip=10.0.0.3,port=6380,state=online,offset=10500,lag=0' }),
      T0,
    )!;
    expect(sample.replicas.map((r) => r.gapBytes)).toEqual([1000, 0]);
  });

  it('has no write rate on the first poll and bytes/sec on the second', () => {
    const tracker = new ReplicationStreamTracker();
    const first = tracker.observe('c1', primaryInfo(), T0)!;
    expect(first.bytesPerSec).toBeNull();
    expect(first.bytesPerSecEwma).toBeNull();

    const second = tracker.observe('c1', primaryInfo({ master_repl_offset: '14000' }), T0 + 2000)!;
    expect(second.bytesPerSec).toBe(2000);
    expect(second.bytesPerSecEwma).toBe(2000);
  });

  it('smooths the rate with an EWMA', () => {
    const tracker = new ReplicationStreamTracker();
    tracker.observe('c1', primaryInfo({ master_repl_offset: '0' }), T0);
    tracker.observe('c1', primaryInfo({ master_repl_offset: '1000' }), T0 + 1000);
    const third = tracker.observe('c1', primaryInfo({ master_repl_offset: '4000' }), T0 + 2000)!;
    expect(third.bytesPerSec).toBe(3000);
    expect(third.bytesPerSecEwma).toBeCloseTo(
      REPLICATION_RATE_EWMA_ALPHA * 3000 + (1 - REPLICATION_RATE_EWMA_ALPHA) * 1000,
    );
  });

  it('re-baselines when the offset goes backwards', () => {
    const tracker = new ReplicationStreamTracker();
    tracker.observe('c1', primaryInfo({ master_repl_offset: '5000' }), T0);
    tracker.observe('c1', primaryInfo({ master_repl_offset: '6000' }), T0 + 1000);
    const reset = tracker.observe('c1', primaryInfo({ master_repl_offset: '100' }), T0 + 2000)!;
    expect(reset.bytesPerSec).toBeNull();
    expect(reset.bytesPerSecEwma).toBeNull();

    const next = tracker.observe('c1', primaryInfo({ master_repl_offset: '600' }), T0 + 3000)!;
    expect(next.bytesPerSec).toBe(500);
    expect(next.bytesPerSecEwma).toBe(500);
  });

  it('re-baselines on a new replication history', () => {
    const tracker = new ReplicationStreamTracker();
    tracker.observe('c1', primaryInfo({ master_repl_offset: '5000' }), T0);
    const changed = tracker.observe(
      'c1',
      primaryInfo({ master_replid: REPLID_B, master_repl_offset: '9000' }),
      T0 + 1000,
    )!;
    expect(changed.bytesPerSec).toBeNull();
  });

  it('keeps the rate across a PSYNC2 failover that continues the old history', () => {
    const tracker = new ReplicationStreamTracker();
    tracker.observe('c1', primaryInfo({ master_repl_offset: '5000' }), T0);
    const promoted = tracker.observe(
      'c1',
      primaryInfo({
        master_replid: REPLID_B,
        master_replid2: REPLID_A,
        second_repl_offset: '5001',
        master_repl_offset: '6000',
      }),
      T0 + 1000,
    )!;
    expect(promoted.bytesPerSec).toBe(1000);
  });

  it('keeps the rate when the old history ends exactly at second_repl_offset', () => {
    const tracker = new ReplicationStreamTracker();
    tracker.observe('c1', primaryInfo({ master_repl_offset: '5000' }), T0);
    const promoted = tracker.observe(
      'c1',
      primaryInfo({
        master_replid: REPLID_B,
        master_replid2: REPLID_A,
        second_repl_offset: '5000',
        master_repl_offset: '6000',
      }),
      T0 + 1000,
    )!;
    expect(promoted.bytesPerSec).toBe(1000);
  });

  it('re-baselines when the old history ran past second_repl_offset', () => {
    const tracker = new ReplicationStreamTracker();
    tracker.observe('c1', primaryInfo({ master_repl_offset: '5000' }), T0);
    const promoted = tracker.observe(
      'c1',
      primaryInfo({
        master_replid: REPLID_B,
        master_replid2: REPLID_A,
        second_repl_offset: '4001',
        master_repl_offset: '6000',
      }),
      T0 + 1000,
    )!;
    expect(promoted.bytesPerSec).toBeNull();
  });

  it('re-baselines on a replid2 match without second_repl_offset', () => {
    const tracker = new ReplicationStreamTracker();
    tracker.observe('c1', primaryInfo({ master_repl_offset: '5000' }), T0);
    const promoted = tracker.observe(
      'c1',
      primaryInfo({
        master_replid: REPLID_B,
        master_replid2: REPLID_A,
        master_repl_offset: '6000',
      }),
      T0 + 1000,
    )!;
    expect(promoted.bytesPerSec).toBeNull();
  });

  it('skips the rate when no time has passed', () => {
    const tracker = new ReplicationStreamTracker();
    tracker.observe('c1', primaryInfo(), T0);
    expect(tracker.observe('c1', primaryInfo({ master_repl_offset: '20000' }), T0)!.bytesPerSec).toBeNull();
  });

  it('computes the rate on a replica but reports no replicas', () => {
    const tracker = new ReplicationStreamTracker();
    const info = {
      role: 'slave',
      master_replid: REPLID_A,
      master_repl_offset: '1000',
      slave_repl_offset: '1000',
    };
    tracker.observe('r1', info, T0);
    const sample = tracker.observe('r1', { ...info, master_repl_offset: '3000' }, T0 + 1000)!;
    expect(sample.role).toBe('replica');
    expect(sample.bytesPerSec).toBe(2000);
    expect(sample.replicas).toEqual([]);
  });

  it('reads the backlog capacity, not how full it is', () => {
    const tracker = new ReplicationStreamTracker();
    expect(tracker.observe('c1', primaryInfo(), T0)!.replBacklogSize).toBe(8000);
    expect(
      tracker.observe('c2', primaryInfo({ repl_backlog_size: 'n/a' }), T0)!.replBacklogSize,
    ).toBeNull();
    const { repl_backlog_size: _omit, ...withoutSize } = primaryInfo();
    expect(tracker.observe('c3', withoutSize, T0)!.replBacklogSize).toBeNull();
  });

  it('keeps connections apart and forgets them on request', () => {
    const tracker = new ReplicationStreamTracker();
    tracker.observe('c1', primaryInfo(), T0);
    tracker.observe('c2', primaryInfo({ master_repl_offset: '99' }), T0);
    expect(tracker.latest('c1')!.masterReplOffset).toBe(10000);
    expect(tracker.latest('c2')!.masterReplOffset).toBe(99);

    tracker.forget('c1');
    expect(tracker.latest('c1')).toBeNull();
    const fresh = tracker.observe('c1', primaryInfo({ master_repl_offset: '20000' }), T0 + 1000)!;
    expect(fresh.bytesPerSec).toBeNull();
  });
});
