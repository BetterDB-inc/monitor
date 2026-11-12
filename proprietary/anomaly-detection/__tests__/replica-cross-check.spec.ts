import {
  describeReplicaView,
  replicaCaughtUp,
  replicaReadings,
  ReplicaSample,
  sampleReplicaView,
  UNREACHABLE_REPLICA,
} from '../replica-cross-check';

const MiB = 1024 * 1024;
const REPLID = 'a'.repeat(40);
const ADDR = '10.0.0.2:6379';
const primary = {
  master_repl_offset: String(1_000 * MiB),
  master_replid: REPLID,
  slave0: `ip=10.0.0.2,port=6379,state=online,offset=${1_000 * MiB - 3 * MiB},lag=0`,
};

function replica(behind: number, extra: Record<string, string> = {}) {
  return {
    role: 'slave',
    master_replid: REPLID,
    master_link_status: 'up',
    slave_repl_offset: String(1_000 * MiB - behind),
    ...extra,
  };
}

function view(behind: number, extra: Record<string, string> = {}) {
  const sample = sampleReplicaView(replica(behind, extra), primary, ADDR);
  if (sample.status !== 'ok') throw new Error(`expected ok, got ${sample.status}`);
  return sample.view;
}

describe('replica cross-check', () => {
  it('treats a replica just under 1 MiB behind as caught up', () => {
    expect(view(MiB / 2).gapBytes).toBe(MiB / 2);
    expect(replicaCaughtUp(view(MiB / 2))).toBe(true);
  });

  it('treats a replica exactly 1 MiB behind as behind', () => {
    expect(replicaCaughtUp(view(MiB))).toBe(false);
  });

  it('never treats a replica with its link down as caught up', () => {
    expect(replicaCaughtUp(view(0, { master_link_status: 'down' }))).toBe(false);
  });

  it("takes the primary's gap from the offset the replica acknowledged", () => {
    expect(sampleReplicaView(replica(MiB), primary, ADDR)).toMatchObject({ status: 'ok', primaryGapBytes: 3 * MiB });
    expect(sampleReplicaView(replica(MiB), primary, '10.0.0.9:6379')).toMatchObject({
      status: 'ok',
      primaryGapBytes: null,
    });
  });

  it('reports the apply backlog between what the replica received and applied', () => {
    expect(view(2 * MiB, { slave_read_repl_offset: String(1_000 * MiB - MiB) }).applyBacklogBytes).toBe(MiB);
    expect(view(2 * MiB).applyBacklogBytes).toBeNull();
  });

  it('tells apart a node that is not a replica, follows another history, or gave no offsets', () => {
    expect(sampleReplicaView({ ...replica(0), role: 'master' }, primary, ADDR)).toEqual({
      status: 'not_replica',
      view: null,
      primaryGapBytes: null,
    });
    expect(sampleReplicaView(replica(0, { master_replid: 'b'.repeat(40) }), primary, ADDR)).toEqual({
      status: 'replid_mismatch',
      view: null,
      primaryGapBytes: null,
    });
    expect(sampleReplicaView({ role: 'slave' }, primary, ADDR)).toBe(UNREACHABLE_REPLICA);
    expect(sampleReplicaView(replica(0), { master_replid: REPLID }, ADDR)).toBe(UNREACHABLE_REPLICA);
  });

  it('turns samples into readings for the detector', () => {
    const samples = new Map<string, ReplicaSample>([
      [ADDR, sampleReplicaView(replica(MiB, { master_link_status: 'down' }), primary, ADDR)],
      ['10.0.0.3:6379', UNREACHABLE_REPLICA],
    ]);
    expect(Object.fromEntries(replicaReadings(samples))).toEqual({
      [ADDR]: { status: 'ok', gapBytes: MiB, linkUp: false, primaryGapBytes: 3 * MiB },
      '10.0.0.3:6379': { status: 'unreachable', gapBytes: null, linkUp: false, primaryGapBytes: null },
    });
  });

  it('describes the apply backlog', () => {
    const v = (backlog: number | null) => ({ gapBytes: 10 * MiB, linkStatus: 'up', applyBacklogBytes: backlog });
    expect(describeReplicaView(v(0))).toContain('applied everything it received');
    expect(describeReplicaView(v(MiB / 2))).toMatch(/received .* it has not applied yet\.$/);
    expect(describeReplicaView(v(MiB / 2))).not.toContain('slow to apply');
    expect(describeReplicaView(v(2 * MiB))).toContain('so it is slow to apply.');
    expect(describeReplicaView(v(null))).toMatch(/behind\.$/);
    const caughtUp = { gapBytes: 0, linkStatus: 'up', applyBacklogBytes: 0 };
    expect(describeReplicaView(caughtUp, true)).toContain('acknowledgements are not reaching the primary');
    expect(describeReplicaView(caughtUp, true)).not.toContain('stream is not reaching it');
    expect(describeReplicaView(v(0), true)).toContain('stream is not reaching it');
  });
});
