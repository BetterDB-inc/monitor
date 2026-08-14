import {
  ClientLockoutInput,
  ClientLockoutState,
  LOCKOUT_MIN_STREAK,
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
    expect(evaluateClientLockout(state, high)?.level).toBe('warning');

    const refusing = input({ connectedClients: 900, rejectedConnections: 12 });
    expect(evaluateClientLockout(state, refusing)?.level).toBe('critical');
    expect(
      evaluateClientLockout(state, input({ connectedClients: 900, rejectedConnections: 30 })),
    ).toBeNull();
  });

  it('re-arms after recovery so a recurrence alerts again', () => {
    const high = input({ connectedClients: 900 });
    for (let poll = 0; poll < LOCKOUT_MIN_STREAK; poll++) {
      evaluateClientLockout(state, high);
    }

    evaluateClientLockout(state, input({ connectedClients: 100 }));

    for (let poll = 0; poll < LOCKOUT_MIN_STREAK - 1; poll++) {
      expect(evaluateClientLockout(state, high)).toBeNull();
    }
    expect(evaluateClientLockout(state, high)?.level).toBe('warning');
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
});
