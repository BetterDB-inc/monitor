import { clusterFailoverMessage } from '../webhook-events-pro.service';

describe('clusterFailoverMessage', () => {
  it('names the transition when cluster_state actually moved', () => {
    expect(
      clusterFailoverMessage({
        clusterState: 'fail',
        previousState: 'ok',
        reasons: ['cluster_state'],
      }),
    ).toBe('Cluster state changed from ok to fail');
  });

  it('describes the topology signal when cluster_state held steady', () => {
    // The case this exists for: a clean promotion leaves state at ok, so the
    // old message read "changed from ok to ok" and told an operator nothing.
    expect(
      clusterFailoverMessage({
        clusterState: 'ok',
        previousState: 'ok',
        reasons: ['role_change'],
      }),
    ).toBe('Cluster failover detected while state stayed ok: a node changed role');
  });

  it('lists every signal that fired', () => {
    const message = clusterFailoverMessage({
      clusterState: 'ok',
      previousState: 'ok',
      reasons: ['role_change', 'epoch_bump'],
    });

    expect(message).toContain('a node changed role');
    expect(message).toContain('a configEpoch advanced');
  });

  it('passes an unrecognised reason through rather than dropping it', () => {
    expect(
      clusterFailoverMessage({
        clusterState: 'ok',
        previousState: 'ok',
        reasons: ['something_new'],
      }),
    ).toContain('something_new');
  });

  it('still says something useful with no reasons at all', () => {
    expect(clusterFailoverMessage({ clusterState: 'ok', previousState: 'ok' })).toBe(
      'Cluster failover detected (state ok)',
    );
  });

  it('does not claim a recovery was the failover signal', () => {
    // The dispatcher only adds cluster_state on ok -> fail. A topology failover
    // seen on the same poll as a fail -> ok recovery would otherwise be
    // reported as "changed from fail to ok", hiding the real signal.
    expect(
      clusterFailoverMessage({
        clusterState: 'ok',
        previousState: 'fail',
        reasons: ['role_change'],
      }),
    ).toBe('Cluster failover detected while state stayed ok: a node changed role');
  });

  it('renders the topology signals alongside a real state transition', () => {
    // A cluster-wide outage trips the CLUSTER INFO edge and churns the topology
    // on the same poll. Returning only the transition drops the detail that
    // says which nodes moved.
    const message = clusterFailoverMessage({
      clusterState: 'fail',
      previousState: 'ok',
      reasons: ['cluster_state', 'role_change'],
    });

    expect(message).toContain('from ok to fail');
    expect(message).toContain('a node changed role');
  });

  it('keeps the transition wording for a caller that declares no reasons', () => {
    // anomaly.service dispatches without `reasons` and is the only path that
    // reports fail -> ok recovery. Gating the transition text on `reasons`
    // unconditionally would strip the from/to wording from every one of its
    // alerts.
    expect(clusterFailoverMessage({ clusterState: 'ok', previousState: 'fail' })).toBe(
      'Cluster state changed from fail to ok',
    );
  });

  it('keeps the transition wording for a reasonless ok -> fail caller', () => {
    expect(clusterFailoverMessage({ clusterState: 'fail', previousState: 'ok' })).toBe(
      'Cluster state changed from ok to fail',
    );
  });

  it('does not invent a transition when there is no previous state', () => {
    // The old message read "changed from unknown to fail", which asserts a
    // transition nobody observed. With no baseline, report the state we have.
    expect(clusterFailoverMessage({ clusterState: 'fail' })).toBe(
      'Cluster failover detected (state fail)',
    );
  });

  it('still names the signal when there is no previous state but reasons exist', () => {
    expect(clusterFailoverMessage({ clusterState: 'fail', reasons: ['slot_failures'] })).toContain(
      'slots entered a failed state',
    );
  });
});
