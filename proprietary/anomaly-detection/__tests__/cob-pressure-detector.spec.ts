import {
  COB_CRIT_RATIO,
  COB_PRESSURE_MEMORY_MS,
  COB_RESYNC_REFIRE_MS,
  COB_WARN_RATIO,
  CobConnectionState,
  acknowledgeCobFinding,
  createCobConnectionState,
  evaluateCobPressure,
  parseSlaveOutputBufferLimit,
} from '../cob-pressure-detector';

const MB = 1024 * 1024;
const HARD = 256 * MB;
const SOFT = 64 * MB;
const SOFT_SECONDS = 60;

const LIMIT_RAW = `normal 0 0 0 slave ${HARD} ${SOFT} ${SOFT_SECONDS} pubsub 33554432 8388608 60`;

describe('parseSlaveOutputBufferLimit', () => {
  it('parses the slave triplet out of the full multi-class config value', () => {
    expect(parseSlaveOutputBufferLimit(LIMIT_RAW)).toEqual({
      hardBytes: HARD,
      softBytes: SOFT,
      softSeconds: SOFT_SECONDS,
    });
  });

  it('accepts the replica class alias', () => {
    expect(parseSlaveOutputBufferLimit('normal 0 0 0 replica 100 50 10 pubsub 1 1 1')).toEqual({
      hardBytes: 100,
      softBytes: 50,
      softSeconds: 10,
    });
  });

  it('parses the unlimited triplet', () => {
    expect(parseSlaveOutputBufferLimit('normal 0 0 0 slave 0 0 0 pubsub 1 1 1')).toEqual({
      hardBytes: 0,
      softBytes: 0,
      softSeconds: 0,
    });
  });

  it('returns null for null, empty, or malformed values', () => {
    expect(parseSlaveOutputBufferLimit(null)).toBeNull();
    expect(parseSlaveOutputBufferLimit('')).toBeNull();
    expect(parseSlaveOutputBufferLimit('normal 0 0 0 pubsub 1 1 1')).toBeNull();
    expect(parseSlaveOutputBufferLimit('slave x y z')).toBeNull();
  });
});

describe('evaluateCobPressure', () => {
  const base = 1_700_000_000_000;
  const limit = { hardBytes: HARD, softBytes: SOFT, softSeconds: SOFT_SECONDS };
  const unlimited = { hardBytes: 0, softBytes: 0, softSeconds: 0 };

  function input(over: Partial<Parameters<typeof evaluateCobPressure>[1]> = {}) {
    return {
      replicas: [{ addr: '10.0.0.5:6380', omem: 0 }],
      limit,
      memClientsSlaves: null,
      connectedSlaves: 1,
      syncFullDelta: 0,
      timestamp: base,
      ...over,
    };
  }

  it('stays quiet below the warning threshold', () => {
    const state = createCobConnectionState();
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.5 }] }),
    );
    expect(findings).toHaveLength(0);
  });

  it('fires WARNING at 60% of the hard limit', () => {
    const state = createCobConnectionState();
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * COB_WARN_RATIO }] }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('warning');
    expect(findings[0].kind).toBe('hard-approach');
    expect(findings[0].replicaAddr).toBe('10.0.0.5:6380');
    expect(findings[0].message).toContain('valkey#3963');
    expect(findings[0].message).toContain('60%');
  });

  it('fires CRITICAL at 90% of the hard limit', () => {
    const state = createCobConnectionState();
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * COB_CRIT_RATIO }] }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('critical');
  });

  it('keeps returning an unacknowledged finding, and stops after acknowledgement', () => {
    const state = createCobConnectionState();
    const pressured = input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }] });
    expect(evaluateCobPressure(state, pressured)).toHaveLength(1);
    expect(evaluateCobPressure(state, { ...pressured, timestamp: base + 5_000 })).toHaveLength(1);
    acknowledgeCobFinding(state, evaluateCobPressure(state, pressured)[0]);
    expect(evaluateCobPressure(state, { ...pressured, timestamp: base + 10_000 })).toHaveLength(0);
  });

  it('escalates an acknowledged WARNING to CRITICAL when pressure grows', () => {
    const state = createCobConnectionState();
    const warn = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }] }),
    );
    acknowledgeCobFinding(state, warn[0]);
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.95 }], timestamp: base + 5_000 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('critical');
  });

  it('re-arms after the buffer drains below the warning threshold', () => {
    const state = createCobConnectionState();
    const warn = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }] }),
    );
    acknowledgeCobFinding(state, warn[0]);
    expect(
      evaluateCobPressure(
        state,
        input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.1 }], timestamp: base + 5_000 }),
      ),
    ).toHaveLength(0);
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }], timestamp: base + 10_000 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('warning');
  });

  it('fires WARNING when the soft limit is breached beyond its grace seconds', () => {
    const state = createCobConnectionState();
    const softPressure = SOFT * 0.8;
    expect(
      evaluateCobPressure(
        state,
        input({ replicas: [{ addr: '10.0.0.5:6380', omem: softPressure }] }),
      ),
    ).toHaveLength(0);
    const findings = evaluateCobPressure(
      state,
      input({
        replicas: [{ addr: '10.0.0.5:6380', omem: softPressure }],
        timestamp: base + (SOFT_SECONDS + 5) * 1000,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('soft-sustained');
    expect(findings[0].level).toBe('warning');
    expect(findings[0].ratio).toBeCloseTo(0.8);
  });

  it('resets the soft-limit clock when the buffer drops below the soft threshold', () => {
    const state = createCobConnectionState();
    const softPressure = SOFT * 0.8;
    evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: softPressure }] }),
    );
    evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: SOFT * 0.1 }], timestamp: base + 30_000 }),
    );
    const findings = evaluateCobPressure(
      state,
      input({
        replicas: [{ addr: '10.0.0.5:6380', omem: softPressure }],
        timestamp: base + (SOFT_SECONDS + 10) * 1000,
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it('ignores the soft limit entirely when softSeconds is 0 (disabled)', () => {
    const state = createCobConnectionState();
    const disabledSoft = { hardBytes: HARD, softBytes: SOFT, softSeconds: 0 };
    const softPressure = SOFT * 0.8;
    evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: softPressure }], limit: disabledSoft }),
    );
    const sustained = evaluateCobPressure(
      state,
      input({
        replicas: [{ addr: '10.0.0.5:6380', omem: softPressure }],
        limit: disabledSoft,
        timestamp: base + 120_000,
      }),
    );
    expect(sustained).toHaveLength(0);
    const coincidence = evaluateCobPressure(
      state,
      input({
        replicas: [],
        limit: disabledSoft,
        syncFullDelta: 1,
        timestamp: base + 130_000,
      }),
    );
    expect(coincidence).toHaveLength(0);
  });

  it('a single-poll sync_full burst reaches the loop threshold under an unlimited limit', () => {
    const state = createCobConnectionState();
    const findings = evaluateCobPressure(state, input({ limit: unlimited, syncFullDelta: 2 }));
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('resync-loop');
  });

  it('skips ratio alerts entirely on an unlimited limit', () => {
    const state = createCobConnectionState();
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: 10_000 * MB }], limit: unlimited }),
    );
    expect(findings).toHaveLength(0);
  });

  it('flags a resync loop on repeated sync_full increments under an unlimited limit', () => {
    const state = createCobConnectionState();
    evaluateCobPressure(state, input({ limit: unlimited, syncFullDelta: 1 }));
    const findings = evaluateCobPressure(
      state,
      input({ limit: unlimited, syncFullDelta: 1, timestamp: base + 30_000 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('resync-loop');
    expect(findings[0].level).toBe('critical');
    expect(findings[0].message).toContain('unlimited');
  });

  it('does not count sync_full increments explained by replica-count growth', () => {
    const state = createCobConnectionState();
    evaluateCobPressure(state, input({ limit: unlimited, replicas: [], connectedSlaves: 1 }));
    const findings = evaluateCobPressure(
      state,
      input({
        limit: unlimited,
        replicas: [],
        connectedSlaves: 3,
        syncFullDelta: 2,
        timestamp: base + 30_000,
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag a rolling replica restart under an unlimited limit', () => {
    const state = createCobConnectionState();
    evaluateCobPressure(state, input({ limit: unlimited, replicas: [], connectedSlaves: 1 }));
    evaluateCobPressure(
      state,
      input({ limit: unlimited, replicas: [], connectedSlaves: 0, timestamp: base + 30_000 }),
    );
    const findings = evaluateCobPressure(
      state,
      input({
        limit: unlimited,
        replicas: [],
        connectedSlaves: 1,
        syncFullDelta: 1,
        timestamp: base + 60_000,
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it('suppresses resync-loop re-emission until the refire window passes', () => {
    const state = createCobConnectionState();
    evaluateCobPressure(state, input({ limit: unlimited, syncFullDelta: 1 }));
    const first = evaluateCobPressure(
      state,
      input({ limit: unlimited, syncFullDelta: 1, timestamp: base + 30_000 }),
    );
    expect(first).toHaveLength(1);
    acknowledgeCobFinding(state, first[0]);

    const suppressed = evaluateCobPressure(
      state,
      input({ limit: unlimited, syncFullDelta: 1, timestamp: base + 60_000 }),
    );
    expect(suppressed).toHaveLength(0);

    const afterCooldown = evaluateCobPressure(
      state,
      input({
        limit: unlimited,
        syncFullDelta: 1,
        timestamp: base + 30_000 + COB_RESYNC_REFIRE_MS + 1_000,
      }),
    );
    expect(afterCooldown).toHaveLength(1);
  });

  it('reports an unreadable limit distinctly from a genuinely unlimited one', () => {
    const state = createCobConnectionState();
    evaluateCobPressure(state, input({ limit: null, replicas: null, syncFullDelta: 1 }));
    const findings = evaluateCobPressure(
      state,
      input({ limit: null, replicas: null, syncFullDelta: 1, timestamp: base + 30_000 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('CONFIG GET denied');
    expect(findings[0].message).not.toContain('unlimited');
  });

  it('does not blame a drained-but-connected replica for a sync_full increment', () => {
    const state = createCobConnectionState();
    const warn = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }] }),
    );
    acknowledgeCobFinding(state, warn[0]);
    const findings = evaluateCobPressure(
      state,
      input({
        replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.05 }],
        syncFullDelta: 1,
        timestamp: base + 10_000,
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it('a soft breach inside the grace window arms the resync coincidence', () => {
    const state = createCobConnectionState();
    const softPressure = SOFT * 0.8;
    expect(
      evaluateCobPressure(
        state,
        input({ replicas: [{ addr: '10.0.0.5:6380', omem: softPressure }] }),
      ),
    ).toHaveLength(0);
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [], syncFullDelta: 1, timestamp: base + 10_000 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('resync-loop');
    expect(findings[0].replicaAddr).toBe('10.0.0.5:6380');
  });

  it('does not blame a still-pressured replica for another replica joining (global sync_full)', () => {
    const state = createCobConnectionState();
    const warn = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }] }),
    );
    acknowledgeCobFinding(state, warn[0]);
    const findings = evaluateCobPressure(
      state,
      input({
        replicas: [
          { addr: '10.0.0.5:6380', omem: HARD * 0.7 },
          { addr: '10.0.0.9:6380', omem: 0 },
        ],
        syncFullDelta: 1,
        timestamp: base + 10_000,
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it('an observed recovery clears pressure memory before an unrelated disconnect', () => {
    const state = createCobConnectionState();
    const warn = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }] }),
    );
    acknowledgeCobFinding(state, warn[0]);
    evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.05 }], timestamp: base + 10_000 }),
    );
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [], syncFullDelta: 1, timestamp: base + 20_000 }),
    );
    expect(findings).toHaveLength(0);
  });

  it('fires the resync loop when the pressured replica vanished from CLIENT LIST', () => {
    const state = createCobConnectionState();
    const warn = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }] }),
    );
    acknowledgeCobFinding(state, warn[0]);
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [], syncFullDelta: 1, timestamp: base + 10_000 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('resync-loop');
    expect(findings[0].replicaAddr).toBe('10.0.0.5:6380');
  });

  it('does not fire on a sync_full increment without prior pressure (fresh replica)', () => {
    const state = createCobConnectionState();
    evaluateCobPressure(state, input({}));
    const findings = evaluateCobPressure(
      state,
      input({ syncFullDelta: 1, timestamp: base + 10_000 }),
    );
    expect(findings).toHaveLength(0);
  });

  it('forgets pressure older than the coincidence memory window', () => {
    const state = createCobConnectionState();
    const warn = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }] }),
    );
    acknowledgeCobFinding(state, warn[0]);
    const later = base + COB_PRESSURE_MEMORY_MS + 60_000;
    evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.05 }], timestamp: later }),
    );
    const findings = evaluateCobPressure(
      state,
      input({
        replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.05 }],
        syncFullDelta: 1,
        timestamp: later + 10_000,
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it('degrades to the aggregate ratio when the replica list is unavailable', () => {
    const state = createCobConnectionState();
    const findings = evaluateCobPressure(
      state,
      input({
        replicas: null,
        memClientsSlaves: HARD * 0.7 * 2,
        connectedSlaves: 2,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('warning');
    expect(findings[0].message).toContain('reduced fidelity');
  });

  it('stale aggregate pressure does not arm the coincidence once CLIENT LIST recovers', () => {
    const state = createCobConnectionState();
    const warn = evaluateCobPressure(
      state,
      input({ replicas: null, memClientsSlaves: HARD * 0.7 * 2, connectedSlaves: 2 }),
    );
    expect(warn).toHaveLength(1);
    acknowledgeCobFinding(state, warn[0]);
    evaluateCobPressure(
      state,
      input({
        replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.05 }],
        timestamp: base + 10_000,
      }),
    );
    const findings = evaluateCobPressure(
      state,
      input({
        replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.05 }],
        syncFullDelta: 1,
        timestamp: base + 20_000,
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it('returns nothing with no replicas connected', () => {
    const state = createCobConnectionState();
    expect(evaluateCobPressure(state, input({ replicas: [], connectedSlaves: 0 }))).toHaveLength(0);
  });

  it('keeps hysteresis across a reconnect with the same address', () => {
    const state = createCobConnectionState();
    const warn = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.7 }] }),
    );
    acknowledgeCobFinding(state, warn[0]);
    const findings = evaluateCobPressure(
      state,
      input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.75 }], timestamp: base + 5_000 }),
    );
    expect(findings).toHaveLength(0);
  });

  it('prunes replicas that stay gone past the memory window', () => {
    const state: CobConnectionState = createCobConnectionState();
    evaluateCobPressure(state, input({ replicas: [{ addr: '10.0.0.5:6380', omem: HARD * 0.1 }] }));
    expect(state.replicas.has('10.0.0.5:6380')).toBe(true);
    evaluateCobPressure(
      state,
      input({
        replicas: [],
        connectedSlaves: 0,
        timestamp: base + COB_PRESSURE_MEMORY_MS + 60_000,
      }),
    );
    expect(state.replicas.has('10.0.0.5:6380')).toBe(false);
  });
});
