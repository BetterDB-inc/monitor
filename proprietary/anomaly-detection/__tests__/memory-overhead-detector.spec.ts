import {
  MemoryOverheadInput,
  OVERHEAD_CRIT_FRACTION,
  OVERHEAD_WARN_FRACTION,
  OverheadComponents,
  acknowledgeMemoryOverheadFinding,
  createMemoryOverheadState,
  evaluateMemoryOverhead,
} from '../memory-overhead-detector';

const MB = 1024 * 1024;
const MAXMEMORY = 1000 * MB;

function components(over: Partial<OverheadComponents> = {}): OverheadComponents {
  return {
    clientsNormal: 0,
    clientsSlaves: 0,
    replBacklog: 0,
    replBuffers: 0,
    aofBuffer: 0,
    scriptsFunctions: 0,
    clusterLinks: 0,
    ...over,
  };
}

describe('evaluateMemoryOverhead', () => {
  const base = 1_700_000_000_000;
  const startup = 5 * MB;

  /**
   * Builds an input where operational overhead (used_memory_overhead - startup)
   * is `overheadBytes`, split across components (dominant = clientsNormal by
   * default). usedMemory defaults comfortably below maxmemory so nothing reads
   * as "squeezing" unless the test opts in.
   */
  function input(over: Partial<MemoryOverheadInput> = {}): MemoryOverheadInput {
    const overheadBytes = over.usedMemoryOverhead ?? startup + 100 * MB;
    return {
      usedMemory: 300 * MB,
      usedMemoryOverhead: overheadBytes,
      usedMemoryStartup: startup,
      usedMemoryDataset: 250 * MB,
      maxmemory: MAXMEMORY,
      maxmemoryPolicy: 'allkeys-lru',
      components: components({ clientsNormal: overheadBytes - startup }),
      evictedKeysDelta: 0,
      timestamp: base,
      ...over,
    };
  }

  it('returns null when maxmemory is 0 (no eviction budget)', () => {
    const state = createMemoryOverheadState();
    const finding = evaluateMemoryOverhead(
      state,
      input({ maxmemory: 0, usedMemoryOverhead: startup + 900 * MB }),
    );
    expect(finding).toBeNull();
  });

  it('stays quiet below the warning fraction', () => {
    const state = createMemoryOverheadState();
    // operational overhead = 20% of maxmemory, below the 30% WARN floor.
    const finding = evaluateMemoryOverhead(
      state,
      input({ usedMemoryOverhead: startup + 0.2 * MAXMEMORY }),
    );
    expect(finding).toBeNull();
  });

  it('fires WARNING at the warn fraction of maxmemory', () => {
    const state = createMemoryOverheadState();
    const finding = evaluateMemoryOverhead(
      state,
      input({ usedMemoryOverhead: startup + OVERHEAD_WARN_FRACTION * MAXMEMORY }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('warning');
    expect(finding!.overheadFraction).toBeCloseTo(OVERHEAD_WARN_FRACTION, 5);
    expect(finding!.message).toContain('valkey#1792');
    expect(finding!.message).toContain('WARNING');
    expect(finding!.message).toContain('% of maxmemory');
  });

  it('fires CRITICAL at the critical fraction of maxmemory', () => {
    const state = createMemoryOverheadState();
    const finding = evaluateMemoryOverhead(
      state,
      input({ usedMemoryOverhead: startup + OVERHEAD_CRIT_FRACTION * MAXMEMORY }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('critical');
    expect(finding!.message).toContain('CRITICAL');
  });

  it('excludes the startup baseline from operational overhead', () => {
    const state = createMemoryOverheadState();
    // Total overhead is 35% of maxmemory but ALL of it is startup baseline —
    // operational overhead is 0, so no finding.
    const finding = evaluateMemoryOverhead(
      state,
      input({
        usedMemoryStartup: 0.35 * MAXMEMORY,
        usedMemoryOverhead: 0.35 * MAXMEMORY,
        components: components(),
      }),
    );
    expect(finding).toBeNull();
  });

  it('fires eviction-driven CRITICAL below the crit fraction when overhead squeezes data out', () => {
    const state = createMemoryOverheadState();
    // Overhead = 35% of maxmemory (WARNING band by fraction alone), but the
    // dataset already fills the rest so remaining budget < overhead, and
    // eviction is actively firing → escalated to CRITICAL.
    const overhead = startup + 0.35 * MAXMEMORY;
    const finding = evaluateMemoryOverhead(
      state,
      input({
        usedMemoryOverhead: overhead,
        components: components({ clientsNormal: 0.35 * MAXMEMORY }),
        usedMemory: 0.95 * MAXMEMORY,
        evictedKeysDelta: 42,
        maxmemoryPolicy: 'allkeys-lru',
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('critical');
    expect(finding!.message).toContain('squeezing user data out');
    expect(finding!.message).toContain('42');
  });

  it('does not escalate on eviction under noeviction policy', () => {
    const state = createMemoryOverheadState();
    const finding = evaluateMemoryOverhead(
      state,
      input({
        usedMemoryOverhead: startup + 0.35 * MAXMEMORY,
        components: components({ clientsNormal: 0.35 * MAXMEMORY }),
        usedMemory: 0.95 * MAXMEMORY,
        evictedKeysDelta: 42,
        maxmemoryPolicy: 'noeviction',
      }),
    );
    // Still a WARNING by fraction (35% >= 30%), but NOT the eviction CRITICAL.
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('warning');
  });

  it('names the dominant overhead component in the message', () => {
    const state = createMemoryOverheadState();
    const finding = evaluateMemoryOverhead(
      state,
      input({
        usedMemoryOverhead: startup + 0.4 * MAXMEMORY,
        components: components({
          clientsNormal: 50 * MB,
          replBacklog: 300 * MB, // dominant
          aofBuffer: 20 * MB,
        }),
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.dominantComponent).toBe('replBacklog');
    expect(finding!.message).toContain('replication backlog');
    expect(finding!.message).toContain('repl-backlog-size');
  });

  it('keeps returning an unacknowledged finding, and stops after acknowledgement', () => {
    const state = createMemoryOverheadState();
    const warn = input({ usedMemoryOverhead: startup + 0.35 * MAXMEMORY });
    expect(evaluateMemoryOverhead(state, warn)).not.toBeNull();
    // Unacknowledged: re-returned on the next poll (so a failed emit retries).
    expect(evaluateMemoryOverhead(state, { ...warn, timestamp: base + 5_000 })).not.toBeNull();
    const finding = evaluateMemoryOverhead(state, { ...warn, timestamp: base + 10_000 });
    acknowledgeMemoryOverheadFinding(state, finding!);
    // Acknowledged: steady state stays quiet.
    expect(evaluateMemoryOverhead(state, { ...warn, timestamp: base + 15_000 })).toBeNull();
  });

  it('escalates an acknowledged WARNING to CRITICAL when overhead grows', () => {
    const state = createMemoryOverheadState();
    const warn = evaluateMemoryOverhead(
      state,
      input({ usedMemoryOverhead: startup + 0.35 * MAXMEMORY }),
    );
    acknowledgeMemoryOverheadFinding(state, warn!);
    const crit = evaluateMemoryOverhead(
      state,
      input({ usedMemoryOverhead: startup + 0.55 * MAXMEMORY, timestamp: base + 5_000 }),
    );
    expect(crit).not.toBeNull();
    expect(crit!.level).toBe('critical');
  });

  it('does not re-emit a CRITICAL that stays critical (hysteresis)', () => {
    const state = createMemoryOverheadState();
    const crit = evaluateMemoryOverhead(
      state,
      input({ usedMemoryOverhead: startup + 0.6 * MAXMEMORY }),
    );
    acknowledgeMemoryOverheadFinding(state, crit!);
    expect(
      evaluateMemoryOverhead(
        state,
        input({ usedMemoryOverhead: startup + 0.62 * MAXMEMORY, timestamp: base + 5_000 }),
      ),
    ).toBeNull();
  });

  it('re-arms after overhead drops, then alerts again on a fresh escalation', () => {
    const state = createMemoryOverheadState();
    const warn = evaluateMemoryOverhead(
      state,
      input({ usedMemoryOverhead: startup + 0.35 * MAXMEMORY }),
    );
    acknowledgeMemoryOverheadFinding(state, warn!);
    // Drops below the warning band — re-arms (no finding, ackedLevel lowered).
    expect(
      evaluateMemoryOverhead(
        state,
        input({ usedMemoryOverhead: startup + 0.1 * MAXMEMORY, timestamp: base + 5_000 }),
      ),
    ).toBeNull();
    // A fresh escalation alerts again.
    const again = evaluateMemoryOverhead(
      state,
      input({ usedMemoryOverhead: startup + 0.35 * MAXMEMORY, timestamp: base + 10_000 }),
    );
    expect(again).not.toBeNull();
    expect(again!.level).toBe('warning');
  });
});
