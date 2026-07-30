import {
  FORK_OOM_CRIT_FRACTION,
  FORK_OOM_WARN_FRACTION,
  FORK_PROJECT_CHANGES_THRESHOLD,
  SLOW_FORK_USEC,
  ForkMemoryInput,
  acknowledgeForkMemoryFinding,
  createForkMemoryState,
  evaluateForkMemoryRisk,
} from '../fork-memory-risk-detector';

const GB = 1024 * 1024 * 1024;
const TOTAL = 16 * GB;

describe('evaluateForkMemoryRisk', () => {
  const base = 1_700_000_000_000;

  function input(over: Partial<ForkMemoryInput> = {}): ForkMemoryInput {
    return {
      bgsaveInProgress: false,
      aofRewriteInProgress: false,
      currentCowSize: null,
      rdbLastCowSize: null,
      aofLastCowSize: null,
      latestForkUsec: 20_000,
      usedMemory: 4 * GB,
      usedMemoryRss: 4 * GB,
      totalSystemMemory: TOTAL,
      maxmemory: 0,
      changesSinceLastSave: 0,
      timestamp: base,
      ...over,
    };
  }

  it('exports thresholds with the documented defaults', () => {
    expect(FORK_OOM_WARN_FRACTION).toBe(0.8);
    expect(FORK_OOM_CRIT_FRACTION).toBe(0.9);
    expect(SLOW_FORK_USEC).toBe(500_000);
  });

  it('stays quiet with no save in progress and low write pressure', () => {
    const state = createForkMemoryState();
    expect(evaluateForkMemoryRisk(state, input())).toBeNull();
  });

  it('stays quiet during a live save with safe headroom', () => {
    const state = createForkMemoryState();
    // 8GB + 0 COW = 8/16 = 50% → well under the warning fraction.
    const finding = evaluateForkMemoryRisk(
      state,
      input({ bgsaveInProgress: true, usedMemoryRss: 8 * GB, currentCowSize: 0 }),
    );
    expect(finding).toBeNull();
  });

  it('fires CRITICAL when a live save projects >= 90% of system memory', () => {
    const state = createForkMemoryState();
    // 14GB RSS + 1GB COW = 15/16 = 93.75% → critical.
    const finding = evaluateForkMemoryRisk(
      state,
      input({ bgsaveInProgress: true, usedMemoryRss: 14 * GB, currentCowSize: 1 * GB }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('critical');
    expect(finding!.kind).toBe('live-cow-oom');
    expect(finding!.projectedFraction).toBeCloseTo(15 / 16, 5);
    expect(finding!.message).toContain('valkey#3609');
    expect(finding!.message).toContain('93.8%');
    expect(finding!.message).toContain('BGSAVE in progress');
    expect(finding!.message).toContain('vm.overcommit_memory=1');
    expect(finding!.message).toContain('forkless');
  });

  it('fires WARNING when a live save projects 80-90% of system memory', () => {
    const state = createForkMemoryState();
    // 13GB RSS + 0.2GB COW = 13.2/16 = 82.5% → warning.
    const finding = evaluateForkMemoryRisk(
      state,
      input({ bgsaveInProgress: true, usedMemoryRss: 13 * GB, currentCowSize: 0.2 * GB }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('warning');
    expect(finding!.kind).toBe('live-cow-oom');
  });

  it('labels an AOF rewrite when only aof_rewrite_in_progress is set', () => {
    const state = createForkMemoryState();
    const finding = evaluateForkMemoryRisk(
      state,
      input({ aofRewriteInProgress: true, usedMemoryRss: 14 * GB, currentCowSize: 1 * GB }),
    );
    expect(finding!.message).toContain('AOF rewrite in progress');
  });

  it('falls back to used_memory when used_memory_rss is missing (live path)', () => {
    const state = createForkMemoryState();
    const finding = evaluateForkMemoryRisk(
      state,
      input({
        bgsaveInProgress: true,
        usedMemoryRss: null,
        usedMemory: 14 * GB,
        currentCowSize: 1 * GB,
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('critical');
  });

  it('fires WARNING for the projected next fork when idle with high write pressure', () => {
    const state = createForkMemoryState();
    // No save; 13GB RSS + 0.5GB last-save COW = 13.5/16 = 84.4% and heavy writes.
    const finding = evaluateForkMemoryRisk(
      state,
      input({
        usedMemoryRss: 13 * GB,
        rdbLastCowSize: 0.5 * GB,
        changesSinceLastSave: FORK_PROJECT_CHANGES_THRESHOLD + 1,
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('warning');
    expect(finding!.kind).toBe('projected-fork-oom');
    expect(finding!.message).toContain('No save in progress');
    expect(finding!.message).toContain('valkey#3609');
    expect(finding!.message).toContain('changes_since_last_save');
  });

  it('projects an AOF-only deployment from aof_last_cow_size (no RDB COW history)', () => {
    const state = createForkMemoryState();
    // AOF-only: rdb_last_cow_size is 0/absent but the last AOF rewrite's COW is
    // the estimator for the next fork.
    const finding = evaluateForkMemoryRisk(
      state,
      input({
        usedMemoryRss: 13 * GB,
        rdbLastCowSize: 0,
        aofLastCowSize: 0.5 * GB,
        changesSinceLastSave: FORK_PROJECT_CHANGES_THRESHOLD + 1,
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('warning');
    expect(finding!.kind).toBe('projected-fork-oom');
  });

  it('does NOT treat read traffic as write pressure (high ops/sec, low changes)', () => {
    const state = createForkMemoryState();
    // Read-heavy: a prior COW footprint and high RSS, but writes (the only
    // signal that grows changes_since_last_save) are low — must not project.
    const finding = evaluateForkMemoryRisk(
      state,
      input({ usedMemoryRss: 13 * GB, rdbLastCowSize: 0.5 * GB, changesSinceLastSave: 10 }),
    );
    expect(finding).toBeNull();
  });

  it('does NOT project when write pressure is low even if the next fork would be large', () => {
    const state = createForkMemoryState();
    const finding = evaluateForkMemoryRisk(
      state,
      input({ usedMemoryRss: 13 * GB, rdbLastCowSize: 0.5 * GB, changesSinceLastSave: 10 }),
    );
    expect(finding).toBeNull();
  });

  it('does NOT project without a real basis (no rdb or aof last COW)', () => {
    const state = createForkMemoryState();
    const finding = evaluateForkMemoryRisk(
      state,
      input({
        usedMemoryRss: 15 * GB,
        rdbLastCowSize: 0,
        aofLastCowSize: 0,
        changesSinceLastSave: FORK_PROJECT_CHANGES_THRESHOLD + 1,
      }),
    );
    expect(finding).toBeNull();
  });

  it('does NOT project when the next fork stays under safe headroom', () => {
    const state = createForkMemoryState();
    // 4GB + 0.5GB = 4.5/16 = 28% → under the warning fraction.
    const finding = evaluateForkMemoryRisk(
      state,
      input({
        usedMemoryRss: 4 * GB,
        rdbLastCowSize: 0.5 * GB,
        changesSinceLastSave: FORK_PROJECT_CHANGES_THRESHOLD + 1,
      }),
    );
    expect(finding).toBeNull();
  });

  it('cannot assess without total_system_memory (live path returns null)', () => {
    const state = createForkMemoryState();
    const finding = evaluateForkMemoryRisk(
      state,
      input({
        bgsaveInProgress: true,
        usedMemoryRss: 14 * GB,
        currentCowSize: 4 * GB,
        totalSystemMemory: null,
      }),
    );
    expect(finding).toBeNull();
  });

  it('cannot assess without total_system_memory (projected path returns null)', () => {
    const state = createForkMemoryState();
    const finding = evaluateForkMemoryRisk(
      state,
      input({
        usedMemoryRss: 14 * GB,
        rdbLastCowSize: 4 * GB,
        changesSinceLastSave: FORK_PROJECT_CHANGES_THRESHOLD + 1,
        totalSystemMemory: null,
      }),
    );
    expect(finding).toBeNull();
  });

  it('appends a slow-fork note when latest_fork_usec is large', () => {
    const state = createForkMemoryState();
    const finding = evaluateForkMemoryRisk(
      state,
      input({
        bgsaveInProgress: true,
        usedMemoryRss: 14 * GB,
        currentCowSize: 1 * GB,
        latestForkUsec: SLOW_FORK_USEC + 300_000, // 0.8s
      }),
    );
    expect(finding!.message).toContain('latest_fork_usec');
    expect(finding!.message).toContain('THP');
  });

  it('omits the slow-fork note when the fork was fast', () => {
    const state = createForkMemoryState();
    const finding = evaluateForkMemoryRisk(
      state,
      input({
        bgsaveInProgress: true,
        usedMemoryRss: 14 * GB,
        currentCowSize: 1 * GB,
        latestForkUsec: 20_000,
      }),
    );
    expect(finding!.message).not.toContain('latest_fork_usec');
  });

  describe('hysteresis', () => {
    const liveWarn = (ts: number): ForkMemoryInput =>
      input({ bgsaveInProgress: true, usedMemoryRss: 13 * GB, currentCowSize: 0.2 * GB, timestamp: ts });
    const liveCrit = (ts: number): ForkMemoryInput =>
      input({ bgsaveInProgress: true, usedMemoryRss: 14 * GB, currentCowSize: 1 * GB, timestamp: ts });
    const idle = (ts: number): ForkMemoryInput => input({ timestamp: ts });

    it('does not repeat the same level once acknowledged, until it drops and re-arms', () => {
      const state = createForkMemoryState();

      const first = evaluateForkMemoryRisk(state, liveWarn(base));
      expect(first!.level).toBe('warning');
      acknowledgeForkMemoryFinding(state, first!);

      // Still warning next poll → suppressed.
      expect(evaluateForkMemoryRisk(state, liveWarn(base + 1000))).toBeNull();

      // Escalation to critical still fires.
      const crit = evaluateForkMemoryRisk(state, liveCrit(base + 2000));
      expect(crit!.level).toBe('critical');
      acknowledgeForkMemoryFinding(state, crit!);
      expect(evaluateForkMemoryRisk(state, liveCrit(base + 3000))).toBeNull();

      // Risk recedes (save ended / headroom recovered) → re-arm.
      expect(evaluateForkMemoryRisk(state, idle(base + 4000))).toBeNull();

      // A fresh warning after the drop fires again.
      const reArmed = evaluateForkMemoryRisk(state, liveWarn(base + 5000));
      expect(reArmed!.level).toBe('warning');
    });

    it('re-returns an un-acknowledged finding on the next poll', () => {
      const state = createForkMemoryState();
      const first = evaluateForkMemoryRisk(state, liveCrit(base));
      expect(first!.level).toBe('critical');
      // Simulate a failed emit: do NOT acknowledge.
      const second = evaluateForkMemoryRisk(state, liveCrit(base + 1000));
      expect(second).not.toBeNull();
      expect(second!.level).toBe('critical');
    });

    it('de-escalates critical to warning and re-alerts on a later re-escalation', () => {
      const state = createForkMemoryState();
      const crit = evaluateForkMemoryRisk(state, liveCrit(base));
      acknowledgeForkMemoryFinding(state, crit!);

      // Drops to warning (still elevated but below critical) → re-arm at warning.
      expect(evaluateForkMemoryRisk(state, liveWarn(base + 1000))).toBeNull();

      // Back up to critical → fires again.
      const reCrit = evaluateForkMemoryRisk(state, liveCrit(base + 2000));
      expect(reCrit!.level).toBe('critical');
    });
  });
});
