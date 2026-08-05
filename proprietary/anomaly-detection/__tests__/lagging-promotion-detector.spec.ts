import { detectLaggingPromotion, ReplPeer } from '../lagging-promotion-detector';

function peer(over: Partial<ReplPeer> & { connectionId: string }): ReplPeer {
  return { offset: 0, role: 'slave', ...over };
}

describe('detectLaggingPromotion', () => {
  it('returns null when there are no peers to compare against', () => {
    expect(detectLaggingPromotion('c', 100, [], 1)).toBeNull();
  });

  it('flags a sibling replica that was ahead of the promoted node', () => {
    const peers = [peer({ connectionId: 'sib', name: 'replica-b', offset: 500 })];
    const finding = detectLaggingPromotion('promoted', 300, peers, 1);
    expect(finding).toMatchObject({
      promotedId: 'promoted',
      promotedOffset: 300,
      aheadId: 'sib',
      aheadName: 'replica-b',
      aheadOffset: 500,
      lagBytes: 200,
    });
  });

  it('returns null when the promoted node was at or ahead of every sibling', () => {
    const peers = [
      peer({ connectionId: 's1', offset: 100 }),
      peer({ connectionId: 's2', offset: 300 }),
    ];
    // Promoted node is the most advanced → coordinated/clean promotion.
    expect(detectLaggingPromotion('promoted', 300, peers, 1)).toBeNull();
    expect(detectLaggingPromotion('promoted', 400, peers, 1)).toBeNull();
  });

  it('ignores the former primary (master-role peers), only compares replica-to-replica', () => {
    // The master is always slightly ahead of a replica — comparing to it would
    // false-positive on every healthy failover.
    const peers = [peer({ connectionId: 'primary', role: 'master', offset: 999 })];
    expect(detectLaggingPromotion('promoted', 300, peers, 1)).toBeNull();
  });

  it('picks the most-advanced sibling among several replicas', () => {
    const peers = [
      peer({ connectionId: 's1', offset: 400 }),
      peer({ connectionId: 's2', offset: 700 }),
      peer({ connectionId: 's3', offset: 550 }),
    ];
    const finding = detectLaggingPromotion('promoted', 300, peers, 1);
    expect(finding?.aheadId).toBe('s2');
    expect(finding?.lagBytes).toBe(400);
  });

  it('excludes the promoted node itself from the peer scan', () => {
    const peers = [peer({ connectionId: 'promoted', offset: 999 })];
    expect(detectLaggingPromotion('promoted', 300, peers, 1)).toBeNull();
  });

  it('respects the minimum-gap threshold (small jitter does not alert)', () => {
    const peers = [peer({ connectionId: 'sib', offset: 305 })];
    expect(detectLaggingPromotion('promoted', 300, peers, 10)).toBeNull(); // gap 5 < 10
    expect(detectLaggingPromotion('promoted', 300, peers, 5)).not.toBeNull(); // gap 5 >= 5
  });

  it('ignores peers with a non-finite offset and a non-finite promoted offset', () => {
    const peers = [peer({ connectionId: 'sib', offset: NaN })];
    expect(detectLaggingPromotion('promoted', 300, peers, 1)).toBeNull();
    expect(
      detectLaggingPromotion('promoted', NaN, [peer({ connectionId: 'sib', offset: 500 })], 1),
    ).toBeNull();
  });
});
