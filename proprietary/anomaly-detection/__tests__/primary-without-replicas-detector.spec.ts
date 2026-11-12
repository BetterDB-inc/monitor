import {
  DEFAULT_PRIMARY_WITHOUT_REPLICAS_CONFIG,
  PrimaryReplicaInput,
  PrimaryWithoutReplicasFinding,
  ShardReplicaState,
  createShardReplicaState,
  evaluatePrimaryWithoutReplicas,
  syncedReplicaCount,
} from '../primary-without-replicas-detector';

const T0 = 1_700_000_000_000;
const config = DEFAULT_PRIMARY_WITHOUT_REPLICAS_CONFIG;

function input(over: Partial<PrimaryReplicaInput>): PrimaryReplicaInput {
  return {
    role: 'master',
    ownsSlots: true,
    primary: '10.0.0.1:6379 (90735665)',
    slots: '0-5460',
    attached: 2,
    synced: 2,
    persistenceOff: null,
    observer: 'conn-1',
    timestamp: T0,
    ...over,
  };
}

/** Feeds the same observation once per second and returns every finding raised. */
function run(
  state: ShardReplicaState,
  from: number,
  seconds: number,
  over: Partial<PrimaryReplicaInput>,
  cfg = config,
): PrimaryWithoutReplicasFinding[] {
  const findings: PrimaryWithoutReplicasFinding[] = [];
  for (let s = 0; s < seconds; s++) {
    const finding = evaluatePrimaryWithoutReplicas(
      state,
      input({ ...over, timestamp: from + s * 1000 }),
      cfg,
    );
    if (finding) findings.push(finding);
  }
  return findings;
}

/** A shard that has shown two synced replicas for a minute. */
function healthyShard(): ShardReplicaState {
  const state = createShardReplicaState(T0);
  expect(run(state, T0, 60, {})).toEqual([]);
  return state;
}

const ZERO = { attached: 0, synced: 0 };
const START = T0 + 60_000;

describe('evaluatePrimaryWithoutReplicas', () => {
  it('learns the expected replica count and stays quiet while replicas are synced', () => {
    const state = healthyShard();
    expect(state.expectedReplicas).toBe(2);
    expect(state.alerted).toBe('none');
  });

  it('stays quiet for the first 4 seconds without replicas', () => {
    const state = healthyShard();
    // Polls at 0s..4s: the window is 4 seconds old at the last one.
    expect(run(state, START, 5, ZERO)).toEqual([]);
  });

  it('raises one WARNING once the window is 5 seconds old', () => {
    const state = healthyShard();
    const findings = run(state, START, 20, ZERO);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'warning',
      synced: 0,
      attached: 0,
      expected: 2,
      zeroForMs: 5_000,
    });
    expect(findings[0].message).toContain('Primary 10.0.0.1:6379 (90735665) for slots 0-5460');
    expect(findings[0].message).toContain('no synced replica for 5 s');
    expect(findings[0].message).toContain('(0 attached, 0 synced, 2 expected)');
  });

  it('escalates to one CRITICAL at 30 seconds, without a second WARNING', () => {
    const state = healthyShard();
    const findings = run(state, START, 60, ZERO);

    expect(findings.map((f) => f.severity)).toEqual(['warning', 'critical']);
    expect(findings[1].zeroForMs).toBe(30_000);
  });

  it('ends the episode after two healthy polls, and a later window starts a new one', () => {
    const state = healthyShard();
    run(state, START, 10, ZERO);
    expect(state.alerted).toBe('warning');

    run(state, START + 10_000, 1, { attached: 1, synced: 1 });
    expect(state.alerted).toBe('warning');
    run(state, START + 11_000, 1, { attached: 1, synced: 1 });
    expect(state.alerted).toBe('none');

    const again = run(state, START + 12_000, 10, ZERO);
    expect(again.map((f) => f.severity)).toEqual(['warning']);
    expect(again[0].zeroForMs).toBe(5_000);
  });

  it('does not end the episode on a single healthy poll', () => {
    const state = healthyShard();
    run(state, START, 10, ZERO);
    run(state, START + 10_000, 1, { attached: 1, synced: 1 });

    expect(run(state, START + 11_000, 10, ZERO)).toEqual([]);
    expect(state.alerted).toBe('warning');
  });

  it('keeps the clock running through a single healthy poll, so the CRITICAL is not pushed back', () => {
    const state = healthyShard();
    // Polls at 0s..28s, one healthy poll at 29s, then none again at 30s.
    expect(run(state, START, 29, ZERO).map((f) => f.severity)).toEqual(['warning']);
    run(state, START + 29_000, 1, { attached: 1, synced: 1 });
    const findings = run(state, START + 30_000, 1, ZERO);

    expect(findings.map((f) => f.severity)).toEqual(['critical']);
    expect(findings[0].zeroForMs).toBe(30_000);
  });

  it('counts two connections that report the shard in one poll cycle as one healthy poll', () => {
    const state = healthyShard();
    run(state, START, 10, ZERO);
    const healthyCycle = (timestamp: number) => {
      for (const observer of ['conn-1', 'conn-2']) {
        run(state, timestamp, 1, { attached: 1, synced: 1, observer });
      }
    };

    healthyCycle(START + 10_000);
    expect(state.alerted).toBe('warning');
    healthyCycle(START + 11_000);
    expect(state.alerted).toBe('none');
  });

  it('counts a replica that is attached but not synced as no replica', () => {
    const state = healthyShard();
    const findings = run(state, START, 10, { attached: 1, synced: 0 });

    expect(findings.map((f) => f.severity)).toEqual(['warning']);
    expect(findings[0].message).toContain('(1 attached, 0 synced, 2 expected)');
  });

  it('never fires for a node that reports role:master without slots', () => {
    const state = healthyShard();
    expect(run(state, START, 120, { ...ZERO, ownsSlots: false })).toEqual([]);
    expect(state.zeroSince).toBeNull();
  });

  it('never fires for a replica', () => {
    const state = healthyShard();
    expect(run(state, START, 120, { ...ZERO, role: 'slave' })).toEqual([]);
  });

  it('never fires for a primary that never had a replica', () => {
    const state = createShardReplicaState(T0);
    expect(run(state, T0, 600, { ...ZERO, ownsSlots: null, slots: null })).toEqual([]);
    expect(state.expectedReplicas).toBe(0);
  });

  it('fires for a standalone primary that had replicas, without naming slots', () => {
    const state = createShardReplicaState(T0);
    run(state, T0, 5, { ownsSlots: null, slots: null, primary: 'db.example:6379' });
    const findings = run(state, START, 10, {
      ...ZERO,
      ownsSlots: null,
      slots: null,
      primary: 'db.example:6379',
    });

    expect(findings.map((f) => f.severity)).toEqual(['warning']);
    expect(findings[0].message).toContain('Primary db.example:6379 has had no synced replica');
  });

  it('raises CRITICAL at 5 seconds when persistence is off and nothing is attached', () => {
    const state = healthyShard();
    const findings = run(state, START, 60, { ...ZERO, persistenceOff: true });

    expect(findings.map((f) => f.severity)).toEqual(['critical']);
    expect(findings[0].zeroForMs).toBe(5_000);
    expect(findings[0].message).toContain('Persistence is off');
  });

  it.each<[string, boolean | null]>([
    ['unknown', null],
    ['on', false],
  ])('does not escalate early when persistence is %s', (_, persistenceOff) => {
    const state = healthyShard();
    const findings = run(state, START, 10, { ...ZERO, persistenceOff });

    expect(findings.map((f) => f.severity)).toEqual(['warning']);
    expect(findings[0].message).not.toContain('Persistence is off');
  });

  it('does not escalate early while a replica is still attached', () => {
    const state = healthyShard();
    const findings = run(state, START, 10, { attached: 1, synced: 0, persistenceOff: true });

    expect(findings.map((f) => f.severity)).toEqual(['warning']);
  });

  it('keeps one episode when two connections report the same shard', () => {
    const state = healthyShard();
    const findings: PrimaryWithoutReplicasFinding[] = [];
    for (let s = 0; s < 20; s++) {
      for (const primary of ['seed (90735665)', '10.0.0.1:6379 (90735665)']) {
        const finding = evaluatePrimaryWithoutReplicas(
          state,
          input({ ...ZERO, primary, timestamp: START + s * 1000 }),
          config,
        );
        if (finding) findings.push(finding);
      }
    }

    expect(findings.map((f) => f.severity)).toEqual(['warning']);
  });

  it('continues the episode when the shard gets a new primary', () => {
    const state = healthyShard();
    run(state, START, 10, ZERO);
    const afterFailover = run(state, START + 10_000, 10, {
      ...ZERO,
      primary: '10.0.0.2:6379 (aaaaaaaa)',
    });

    expect(afterFailover).toEqual([]);
    expect(state.alerted).toBe('warning');
    expect(state.zeroSince).toBe(START);
  });

  it('turns a level off when its threshold is 0', () => {
    const noWarning = healthyShard();
    expect(
      run(noWarning, START, 60, ZERO, { ...config, warnMs: 0 }).map((f) => f.severity),
    ).toEqual(['critical']);

    const noCritical = healthyShard();
    expect(
      run(noCritical, START, 60, { ...ZERO, persistenceOff: true }, { ...config, critMs: 0 }).map(
        (f) => f.severity,
      ),
    ).toEqual(['warning']);

    const off = healthyShard();
    expect(run(off, START, 60, ZERO, { ...config, warnMs: 0, critMs: 0 })).toEqual([]);
  });

  it('turns the early CRITICAL off together with the WARNING', () => {
    const state = healthyShard();
    const findings = run(
      state,
      START,
      60,
      { ...ZERO, persistenceOff: true },
      { ...config, warnMs: 0 },
    );

    expect(findings.map((f) => f.severity)).toEqual(['critical']);
    expect(findings[0].zeroForMs).toBe(30_000);
  });

  it('raises the expectation at once and lowers it only after the TTL', () => {
    const state = healthyShard();
    run(state, START, 1, { attached: 3, synced: 3 });
    expect(state.expectedReplicas).toBe(3);

    run(state, START + 1_000, 1, { attached: 1, synced: 1 });
    expect(state.expectedReplicas).toBe(3);

    run(state, START + 1_000 + config.expectationTtlMs + 1, 1, { attached: 1, synced: 1 });
    expect(state.expectedReplicas).toBe(1);
  });

  it('ends an open episode once replicas are no longer expected', () => {
    const state = healthyShard();
    run(state, START, 10, ZERO);
    expect(state.alerted).toBe('warning');

    run(state, START + config.expectationTtlMs + 1, 2, ZERO);
    expect(state.expectedReplicas).toBe(0);
    expect(state.alerted).toBe('none');
  });
});

describe('syncedReplicaCount', () => {
  it('counts only replicas in state=online, under either line name', () => {
    expect(
      syncedReplicaCount({
        role: 'master',
        connected_slaves: '3',
        slave0: 'ip=10.0.0.2,port=6379,state=online,offset=100,lag=0',
        slave1: 'ip=10.0.0.3,port=6379,state=wait_bgsave,offset=0,lag=0',
        replica2: 'ip=10.0.0.4,port=6379,state=online,offset=100,lag=1',
      }),
    ).toBe(2);
  });

  it('is 0 without replica lines', () => {
    expect(syncedReplicaCount({ role: 'master', connected_slaves: '0' })).toBe(0);
  });
});
