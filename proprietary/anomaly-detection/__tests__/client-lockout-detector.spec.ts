import {
  ClientLockoutInput,
  ClientLockoutState,
  LOCKOUT_MIN_STREAK,
  commitClientLockoutLevel,
  createClientLockoutState,
  evaluateClientLockout,
} from '../client-lockout-detector';

function input(partial: Partial<ClientLockoutInput> = {}): ClientLockoutInput {
  return {
    connectedClients: 100,
    maxClients: 1000,
    rejectedConnections: 0,
    blockedClients: 0,
    ...partial,
  };
}

describe('evaluateClientLockout', () => {
  let state: ClientLockoutState;

  beforeEach(() => {
    state = createClientLockoutState();
  });

  /** Evaluate and, as the service does, record the level once the emit succeeds. */
  function evaluateAndCommit(current: ClientLockoutState, next: ClientLockoutInput) {
    const finding = evaluateClientLockout(current, next);
    if (finding !== null) {
      commitClientLockoutLevel(current, finding.level);
    }
    return finding;
  }

  it('fires a WARNING once utilization stays above the threshold for the full streak', () => {
    const high = input({ connectedClients: 900 });

    for (let poll = 1; poll < LOCKOUT_MIN_STREAK; poll++) {
      expect(evaluateClientLockout(state, high)).toBeNull();
    }

    const finding = evaluateClientLockout(state, high);
    expect(finding).not.toBeNull();
    expect(finding?.level).toBe('warning');
    expect(finding?.utilizationPct).toBe(90);
    expect(finding?.streak).toBe(LOCKOUT_MIN_STREAK);
  });

  it('suppresses a brief single-poll burst', () => {
    expect(evaluateClientLockout(state, input({ connectedClients: 950 }))).toBeNull();
    expect(evaluateClientLockout(state, input({ connectedClients: 200 }))).toBeNull();
    expect(evaluateClientLockout(state, input({ connectedClients: 950 }))).toBeNull();
    expect(evaluateClientLockout(state, input({ connectedClients: 950 }))).toBeNull();
  });

  it('stays silent on a high-but-flat pool below the threshold', () => {
    const belowThreshold = input({ connectedClients: 800 });
    for (let poll = 0; poll < 10; poll++) {
      expect(evaluateClientLockout(state, belowThreshold)).toBeNull();
    }
  });

  it('fires CRITICAL as soon as rejected_connections climbs, without waiting for the streak', () => {
    expect(evaluateClientLockout(state, input({ rejectedConnections: 4 }))).toBeNull();

    const finding = evaluateClientLockout(state, input({ rejectedConnections: 9 }));
    expect(finding?.level).toBe('critical');
    expect(finding?.rejectedDelta).toBe(5);
  });

  it('escalates warning to critical when refusals start, then stays quiet while steady', () => {
    const high = input({ connectedClients: 900 });
    for (let poll = 0; poll < LOCKOUT_MIN_STREAK - 1; poll++) {
      evaluateClientLockout(state, high);
    }
    expect(evaluateAndCommit(state, high)?.level).toBe('warning');

    const refusing = input({ connectedClients: 900, rejectedConnections: 12 });
    expect(evaluateAndCommit(state, refusing)?.level).toBe('critical');
    expect(
      evaluateAndCommit(state, input({ connectedClients: 900, rejectedConnections: 30 })),
    ).toBeNull();
  });

  it('re-arms after recovery so a recurrence alerts again', () => {
    const high = input({ connectedClients: 900 });
    for (let poll = 0; poll < LOCKOUT_MIN_STREAK; poll++) {
      evaluateAndCommit(state, high);
    }

    evaluateAndCommit(state, input({ connectedClients: 100 }));

    for (let poll = 0; poll < LOCKOUT_MIN_STREAK - 1; poll++) {
      expect(evaluateAndCommit(state, high)).toBeNull();
    }
    expect(evaluateAndCommit(state, high)?.level).toBe('warning');
  });

  it('does not re-alert when refusals come and go against a full ceiling', () => {
    const at = (rejected: number) => {
      return input({ connectedClients: 1000, rejectedConnections: rejected });
    };
    evaluateAndCommit(state, at(0));
    expect(evaluateAndCommit(state, at(5))?.level).toBe('critical');

    // Refusals pause for a poll, then resume. The pressure never went away, so
    // this is one ongoing episode, not three.
    expect(evaluateAndCommit(state, at(5))).toBeNull();
    expect(evaluateAndCommit(state, at(9))).toBeNull();
    expect(evaluateAndCommit(state, at(9))).toBeNull();
    expect(evaluateAndCommit(state, at(14))).toBeNull();
  });

  it('retries the escalation when the emit failed and nothing was committed', () => {
    const high = input({ connectedClients: 900 });
    for (let poll = 0; poll < LOCKOUT_MIN_STREAK - 1; poll++) {
      evaluateClientLockout(state, high);
    }

    // Emit throws: evaluate returned a finding, but the level was never committed.
    expect(evaluateClientLockout(state, high)?.level).toBe('warning');
    expect(state.level).toBe('none');

    expect(evaluateAndCommit(state, high)?.level).toBe('warning');
  });

  it('surfaces refusals that happened while the ceiling was unreadable', () => {
    evaluateAndCommit(state, input({ connectedClients: 100, rejectedConnections: 4 }));

    // maxclients unreadable for a poll, during which refusals climb.
    expect(
      evaluateAndCommit(state, input({ maxClients: null, rejectedConnections: 40 })),
    ).toBeNull();

    const finding = evaluateAndCommit(
      state,
      input({ connectedClients: 100, rejectedConnections: 40 }),
    );
    expect(finding?.level).toBe('critical');
    expect(finding?.rejectedDelta).toBe(36);
  });

  it('degrades gracefully when maxclients is zero or unreadable', () => {
    expect(evaluateClientLockout(state, input({ maxClients: 0 }))).toBeNull();
    expect(evaluateClientLockout(state, input({ maxClients: null }))).toBeNull();
    expect(evaluateClientLockout(state, input({ connectedClients: null }))).toBeNull();
    expect(state.highUtilStreak).toBe(0);
  });

  it('preserves the streak across an unreadable sample rather than disarming', () => {
    const high = input({ connectedClients: 900 });
    evaluateClientLockout(state, high);
    evaluateClientLockout(state, high);
    expect(state.highUtilStreak).toBe(2);

    expect(evaluateClientLockout(state, input({ maxClients: null }))).toBeNull();
    expect(state.highUtilStreak).toBe(2);

    expect(evaluateClientLockout(state, high)?.level).toBe('warning');
  });

  it('treats a counter reset as no refusals rather than a negative delta', () => {
    evaluateClientLockout(state, input({ rejectedConnections: 500 }));
    const finding = evaluateClientLockout(state, input({ rejectedConnections: 0 }));

    expect(finding).toBeNull();
    expect(state.lastRejected).toBe(0);
  });

  it('does not fire on the first poll just because the counter is already non-zero', () => {
    expect(evaluateClientLockout(state, input({ rejectedConnections: 4000 }))).toBeNull();
  });

  it('reports whether the pool is still climbing', () => {
    const climbing = [880, 890, 900];
    let finding = null;
    for (const connectedClients of climbing) {
      finding = evaluateClientLockout(state, input({ connectedClients }));
    }
    expect(finding?.rising).toBe(true);

    state = createClientLockoutState();
    const flat = input({ connectedClients: 900 });
    let flatFinding = null;
    for (let poll = 0; poll < LOCKOUT_MIN_STREAK; poll++) {
      flatFinding = evaluateClientLockout(state, flat);
    }
    expect(flatFinding?.rising).toBe(false);
  });

  it('retries a CRITICAL whose emit failed, without needing fresh refusals', () => {
    // Baseline the refusal counter.
    expect(evaluateClientLockout(state, input({ rejectedConnections: 10 }))).toBeNull();

    // Refusals rise: CRITICAL, but the caller never commits (emit failed).
    const first = evaluateClientLockout(state, input({ rejectedConnections: 25 }));
    expect(first?.level).toBe('critical');

    // Same counter next poll — no NEW refusals. The escalation must still stand.
    const retry = evaluateClientLockout(state, input({ rejectedConnections: 25 }));
    expect(retry?.level).toBe('critical');

    // Once it lands, the baseline advances and a flat counter goes quiet.
    commitClientLockoutLevel(state, 'critical');
    expect(evaluateClientLockout(state, input({ rejectedConnections: 25 }))).toBeNull();
  });
});
