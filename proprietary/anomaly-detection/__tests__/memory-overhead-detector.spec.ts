import {
  INVALID_SAMPLE_NOTE_STREAK,
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
    const datasetBytes = over.usedMemoryDataset ?? 250 * MB;
    return {
      // A consistent INFO sample reports used_memory = dataset + overhead;
      // tests craft an INconsistent one by overriding usedMemory directly.
      usedMemory: datasetBytes + overheadBytes,
      usedMemoryOverhead: overheadBytes,
      usedMemoryStartup: startup,
      usedMemoryDataset: datasetBytes,
      usedMemoryDatasetPerc: null,
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
    expect(finding!.thresholdFraction).toBe(OVERHEAD_WARN_FRACTION);
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
    expect(finding!.thresholdFraction).toBe(OVERHEAD_CRIT_FRACTION);
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

  it('fires eviction-driven CRITICAL when overhead exceeds the dataset and eviction is active', () => {
    const state = createMemoryOverheadState();
    // Overhead = 35% of maxmemory (WARNING band by fraction alone), but it is
    // LARGER than the user dataset itself and eviction is firing → overhead, not
    // data, is driving eviction → escalated to CRITICAL.
    const overhead = startup + 0.35 * MAXMEMORY;
    const finding = evaluateMemoryOverhead(
      state,
      input({
        usedMemoryOverhead: overhead,
        components: components({ clientsNormal: 0.35 * MAXMEMORY }),
        usedMemoryDataset: 0.2 * MAXMEMORY, // 200MB dataset < 350MB overhead
        evictedKeysDelta: 42,
        maxmemoryPolicy: 'allkeys-lru',
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('critical');
    expect(finding!.message).toContain('driving eviction');
    expect(finding!.message).toContain('42');
    // The eviction-driven CRITICAL crosses only the WARN-band floor, so its
    // threshold must be the warn fraction (not the crit fraction) and stay <=
    // the reported overhead — otherwise value < threshold on a CRITICAL.
    expect(finding!.thresholdFraction).toBe(OVERHEAD_WARN_FRACTION);
    expect(finding!.overheadBytes).toBeGreaterThanOrEqual(finding!.thresholdFraction * MAXMEMORY);
  });

  it('does NOT fire eviction-driven CRITICAL for a normal full cache (dataset >> overhead)', () => {
    const state = createMemoryOverheadState();
    // A capacity-bound LRU cache: 35% overhead, but the DATASET is far larger
    // and eviction fires every poll by design. Overhead does not exceed the
    // dataset, so this must stay a WARNING, not a false CRITICAL (finding #1).
    const finding = evaluateMemoryOverhead(
      state,
      input({
        usedMemoryOverhead: startup + 0.35 * MAXMEMORY,
        components: components({ clientsNormal: 0.35 * MAXMEMORY }),
        usedMemory: 0.98 * MAXMEMORY,
        usedMemoryDataset: 0.6 * MAXMEMORY, // 600MB dataset > 350MB overhead
        evictedKeysDelta: 500,
        maxmemoryPolicy: 'allkeys-lru',
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('warning');
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

  it('does not blame a component when the mem_* breakdown is unavailable (all zero)', () => {
    const state = createMemoryOverheadState();
    // High overhead but the per-component breakdown is absent (all 0): must not
    // falsely attribute it to the first component (finding #7).
    const finding = evaluateMemoryOverhead(
      state,
      input({
        usedMemoryOverhead: startup + 0.4 * MAXMEMORY,
        components: components(), // every component 0
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.dominantComponent).toBe('unknown');
    expect(finding!.message).toContain('breakdown unavailable');
    expect(finding!.message).not.toContain('client output buffers');
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

  describe('underflow guard (valkey#1373)', () => {
    /**
     * A sample caught mid-underflow: overhead momentarily exceeds used_memory,
     * so used_memory_dataset (used - overhead) wrapped toward 2^64. Overhead is
     * ALSO above the warn fraction, so without the guard this would fire.
     */
    function underflowedInput(over: Partial<MemoryOverheadInput> = {}): MemoryOverheadInput {
      return input({
        usedMemory: 300 * MB,
        usedMemoryOverhead: startup + 0.35 * MAXMEMORY,
        usedMemoryDataset: 2 ** 64 - 1 * MB,
        usedMemoryDatasetPerc: 6148914691236517,
        ...over,
      });
    }

    it('skips a sample where used_memory_overhead exceeds used_memory', () => {
      const state = createMemoryOverheadState();
      const finding = evaluateMemoryOverhead(state, underflowedInput());
      expect(finding).toBeNull();
    });

    it('skips a sample where used_memory_dataset is implausibly larger than used_memory', () => {
      const state = createMemoryOverheadState();
      // Only the dataset field is absurd: overhead (35% of maxmemory) would
      // fire a WARNING on its own, and overhead <= used_memory.
      const finding = evaluateMemoryOverhead(
        state,
        input({
          usedMemory: 500 * MB,
          usedMemoryOverhead: startup + 0.35 * MAXMEMORY,
          usedMemoryDataset: 2 ** 64 - 350 * MB,
        }),
      );
      expect(finding).toBeNull();
    });

    it('skips a sample where used_memory_dataset_perc exceeds 100', () => {
      const state = createMemoryOverheadState();
      const finding = evaluateMemoryOverhead(
        state,
        input({
          usedMemory: 500 * MB,
          usedMemoryOverhead: startup + 0.35 * MAXMEMORY,
          usedMemoryDatasetPerc: 250.9,
        }),
      );
      expect(finding).toBeNull();
    });

    it('processes a normal sample exactly as before (perc present and sane)', () => {
      const state = createMemoryOverheadState();
      const finding = evaluateMemoryOverhead(
        state,
        input({ usedMemoryOverhead: startup + 0.35 * MAXMEMORY, usedMemoryDatasetPerc: 60.2 }),
      );
      expect(finding).not.toBeNull();
      expect(finding!.level).toBe('warning');
    });

    it('does not re-arm acknowledged hysteresis from an invalid sample', () => {
      const state = createMemoryOverheadState();
      const warn = evaluateMemoryOverhead(
        state,
        input({ usedMemoryOverhead: startup + 0.35 * MAXMEMORY }),
      );
      acknowledgeMemoryOverheadFinding(state, warn!);
      // Poisoned sample whose garbage readings would otherwise compute a 'none'
      // level and lower ackedLevel: overhead > used_memory but only 2.5% of
      // maxmemory. The guard must leave the state untouched.
      expect(
        evaluateMemoryOverhead(
          state,
          underflowedInput({
            usedMemory: 10 * MB,
            usedMemoryOverhead: startup + 20 * MB,
            timestamp: base + 5_000,
          }),
        ),
      ).toBeNull();
      // Steady WARNING after the glitch: still acknowledged, so still quiet.
      expect(
        evaluateMemoryOverhead(
          state,
          input({ usedMemoryOverhead: startup + 0.35 * MAXMEMORY, timestamp: base + 10_000 }),
        ),
      ).toBeNull();
    });

    it('surfaces a persistent inconsistency as a low-severity note after a run of invalid samples', () => {
      const state = createMemoryOverheadState();
      let note = null;
      for (let i = 0; i < INVALID_SAMPLE_NOTE_STREAK; i++) {
        note = evaluateMemoryOverhead(state, underflowedInput({ timestamp: base + i * 5_000 }));
        if (i < INVALID_SAMPLE_NOTE_STREAK - 1) {
          expect(note).toBeNull();
        }
      }
      expect(note).not.toBeNull();
      expect(note!.level).toBe('info');
      expect(note!.message).toContain('valkey#1373');
      // Unacknowledged: re-produced next poll so a failed emit retries.
      const retry = evaluateMemoryOverhead(state, underflowedInput({ timestamp: base + 100_000 }));
      expect(retry).not.toBeNull();
      expect(retry!.level).toBe('info');
      acknowledgeMemoryOverheadFinding(state, retry!);
      // Acknowledged: the continuing run stays quiet.
      expect(
        evaluateMemoryOverhead(state, underflowedInput({ timestamp: base + 105_000 })),
      ).toBeNull();
    });

    it('a valid sample resets the invalid streak (and the note can fire again on a new run)', () => {
      const state = createMemoryOverheadState();
      for (let i = 0; i < INVALID_SAMPLE_NOTE_STREAK - 1; i++) {
        expect(
          evaluateMemoryOverhead(state, underflowedInput({ timestamp: base + i * 5_000 })),
        ).toBeNull();
      }
      // A healthy quiet sample interrupts the run.
      expect(
        evaluateMemoryOverhead(
          state,
          input({ usedMemoryOverhead: startup + 0.1 * MAXMEMORY, timestamp: base + 50_000 }),
        ),
      ).toBeNull();
      // One more invalid sample is a streak of 1, not INVALID_SAMPLE_NOTE_STREAK.
      expect(
        evaluateMemoryOverhead(state, underflowedInput({ timestamp: base + 55_000 })),
      ).toBeNull();
    });
  });
});
