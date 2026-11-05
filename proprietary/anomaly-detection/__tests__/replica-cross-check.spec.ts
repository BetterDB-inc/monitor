import { describeReplicaView, readReplicaView, replicaCaughtUp } from '../replica-cross-check';

const MiB = 1024 * 1024;
const REPLID = 'a'.repeat(40);
const primary = { master_repl_offset: String(1_000 * MiB), master_replid: REPLID };

function replica(behind: number, extra: Record<string, string> = {}) {
  return {
    role: 'slave',
    master_replid: REPLID,
    master_link_status: 'up',
    slave_repl_offset: String(1_000 * MiB - behind),
    ...extra,
  };
}

describe('replica cross-check', () => {
  it('treats a replica just under 1 MiB behind as caught up', () => {
    const view = readReplicaView(replica(MiB / 2), primary)!;
    expect(view.gapBytes).toBe(MiB / 2);
    expect(replicaCaughtUp(view)).toBe(true);
  });

  it('treats a replica exactly 1 MiB behind as behind', () => {
    expect(replicaCaughtUp(readReplicaView(replica(MiB), primary)!)).toBe(false);
  });

  it('never treats a replica with its link down as caught up', () => {
    expect(replicaCaughtUp(readReplicaView(replica(0, { master_link_status: 'down' }), primary)!)).toBe(false);
  });

  it('ignores a node that is not a replica or follows another history', () => {
    expect(readReplicaView({ ...replica(0), role: 'master' }, primary)).toBeNull();
    expect(readReplicaView(replica(0, { master_replid: 'b'.repeat(40) }), primary)).toBeNull();
  });

  it('describes the apply backlog', () => {
    const view = (backlog: number | null) => ({ gapBytes: 10 * MiB, linkStatus: 'up', applyBacklogBytes: backlog });
    expect(describeReplicaView(view(0))).toContain('applied everything it received');
    expect(describeReplicaView(view(MiB / 2))).toMatch(/received .* it has not applied yet\.$/);
    expect(describeReplicaView(view(MiB / 2))).not.toContain('slow to apply');
    expect(describeReplicaView(view(2 * MiB))).toContain('so it is slow to apply.');
    expect(describeReplicaView(view(null))).toMatch(/behind\.$/);
    const caughtUp = { gapBytes: 0, linkStatus: 'up', applyBacklogBytes: 0 };
    expect(describeReplicaView(caughtUp, true)).toContain('acknowledgements are not reaching the primary');
    expect(describeReplicaView(caughtUp, true)).not.toContain('stream is not reaching it');
    expect(describeReplicaView(view(0), true)).toContain('stream is not reaching it');
  });
});
