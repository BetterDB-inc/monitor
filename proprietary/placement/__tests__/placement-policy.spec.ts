import {
  DEFAULT_PLACEMENT_SETTINGS,
  defaultPlacementSettings,
  excludedPrimaryIds,
  excludedShardNodeIds,
  readStoredPlacementSettings,
  validatePlacementSettings,
  type PlacementSettings,
} from '@betterdb/shared';

function withChange(change: Partial<PlacementSettings>): unknown {
  return { ...DEFAULT_PLACEMENT_SETTINGS, ...change };
}

function errorsOf(input: unknown): string[] {
  const result = validatePlacementSettings(input);
  return result.ok ? [] : result.errors;
}

describe('placement policy settings', () => {
  it('has the design defaults', () => {
    expect(DEFAULT_PLACEMENT_SETTINGS).toEqual({
      triggerRatio: 2,
      maxCpuShare: null,
      maxNetworkShare: null,
      nodeCpuLimitUsecPerSecond: 800_000,
      resolveRatio: 1.25,
      sustainMinutes: 30,
      slotCooldownDays: 7,
      noReturnDays: 7,
      maxMigrationsPerHour: 4,
      maxBytesPerHour: 2 * 1024 ** 3,
      maintenanceWindows: [],
      excludedShardIds: [],
      excludedSlots: [],
      abortLatencyMs: 50,
      verifyMinutes: 10,
      verifyTolerance: 0.5,
      autoRollback: true,
    });
  });

  it('accepts the defaults', () => {
    expect(validatePlacementSettings(DEFAULT_PLACEMENT_SETTINGS)).toEqual({
      ok: true,
      settings: DEFAULT_PLACEMENT_SETTINGS,
    });
  });

  it('refuses a resolve ratio at or over the trigger ratio', () => {
    expect(errorsOf(withChange({ resolveRatio: 2, triggerRatio: 2 }))).toEqual([
      expect.stringContaining('resolveRatio'),
    ]);
  });

  it('reports the ratio problem also when another field has the wrong type', () => {
    expect(
      errorsOf(withChange({ resolveRatio: 3, autoRollback: 'true' as unknown as boolean })),
    ).toEqual([
      expect.stringContaining('autoRollback'),
      'resolveRatio: must be below triggerRatio',
    ]);
  });

  it('refuses a maintenance window with no duration', () => {
    const errors = errorsOf(
      withChange({ maintenanceWindows: [{ days: [1], start: '02:00', durationMinutes: 0 }] }),
    );
    expect(errors).toEqual([expect.stringContaining('maintenanceWindows.0.durationMinutes')]);
  });

  it('refuses a maintenance window that starts at a time that does not exist', () => {
    const errors = errorsOf(
      withChange({ maintenanceWindows: [{ days: [1], start: '25:00', durationMinutes: 60 }] }),
    );
    expect(errors).toEqual([expect.stringContaining('maintenanceWindows.0.start')]);
  });

  it('refuses a maintenance window on no day or on a day past Saturday', () => {
    expect(
      errorsOf(
        withChange({ maintenanceWindows: [{ days: [], start: '02:00', durationMinutes: 60 }] }),
      ),
    ).toEqual([expect.stringContaining('maintenanceWindows.0.days')]);
    expect(
      errorsOf(
        withChange({ maintenanceWindows: [{ days: [7], start: '02:00', durationMinutes: 60 }] }),
      ),
    ).toEqual([expect.stringContaining('maintenanceWindows.0.days')]);
  });

  it('refuses a slot outside the 16384 slots', () => {
    expect(errorsOf(withChange({ excludedSlots: [16384] }))).toEqual([
      expect.stringContaining('excludedSlots.0'),
    ]);
  });

  it('refuses a verify tolerance over 1', () => {
    expect(errorsOf(withChange({ verifyTolerance: 1.5 }))).toEqual([
      expect.stringContaining('verifyTolerance'),
    ]);
  });

  it('refuses CPU shares outside 0 to 1', () => {
    expect(errorsOf(withChange({ maxCpuShare: 0 }))).toEqual([
      expect.stringContaining('maxCpuShare'),
    ]);
    expect(errorsOf(withChange({ maxNetworkShare: 1.2 }))).toEqual([
      expect.stringContaining('maxNetworkShare'),
    ]);
  });

  it('accepts a job budget of 0 outside Auto', () => {
    expect(validatePlacementSettings(withChange({ maxMigrationsPerHour: 0 })).ok).toBe(true);
  });

  it('refuses a trigger ratio at or under 1', () => {
    expect(errorsOf(withChange({ triggerRatio: 1, resolveRatio: 1 }))).toEqual(
      expect.arrayContaining([expect.stringContaining('triggerRatio')]),
    );
  });

  it('refuses a missing field and a field of the wrong type', () => {
    const { autoRollback: _dropped, ...partial } = DEFAULT_PLACEMENT_SETTINGS;
    expect(errorsOf(partial)).toEqual([expect.stringContaining('autoRollback')]);
    expect(errorsOf(withChange({ sustainMinutes: '30' as unknown as number }))).toEqual([
      expect.stringContaining('sustainMinutes'),
    ]);
  });

  it('drops unknown fields', () => {
    const result = validatePlacementSettings({ ...DEFAULT_PLACEMENT_SETTINGS, extra: 1 });
    expect(result).toEqual({ ok: true, settings: DEFAULT_PLACEMENT_SETTINGS });
  });

  it('refuses something that is not an object', () => {
    expect(errorsOf(null)).not.toEqual([]);
    expect(errorsOf('policy')).not.toEqual([]);
  });

  it('hands out the defaults frozen, and fresh copies to change', () => {
    expect(Object.isFrozen(DEFAULT_PLACEMENT_SETTINGS)).toBe(true);
    expect(() => DEFAULT_PLACEMENT_SETTINGS.excludedSlots.push(1)).toThrow();
    const copy = defaultPlacementSettings();
    copy.excludedSlots.push(1);
    expect(copy).toEqual({ ...DEFAULT_PLACEMENT_SETTINGS, excludedSlots: [1] });
    expect(DEFAULT_PLACEMENT_SETTINGS.excludedSlots).toEqual([]);
  });

  describe('reading stored settings', () => {
    const stored = {
      ...DEFAULT_PLACEMENT_SETTINGS,
      excludedShardIds: ['n1'],
      excludedSlots: [5, 6],
    };

    it('reads nothing stored as the defaults', () => {
      expect(readStoredPlacementSettings(null)).toEqual({
        settings: DEFAULT_PLACEMENT_SETTINGS,
        invalid: null,
      });
    });

    it('reads a stored JSON document', () => {
      expect(readStoredPlacementSettings(JSON.stringify(stored))).toEqual({
        settings: stored,
        invalid: null,
      });
    });

    it('fills fields a stored document is missing from the defaults', () => {
      expect(readStoredPlacementSettings({ sustainMinutes: 45 })).toEqual({
        settings: { ...DEFAULT_PLACEMENT_SETTINGS, sustainMinutes: 45 },
        invalid: null,
      });
    });

    it('keeps the exclusions of a document with another field that no longer validates', () => {
      const read = readStoredPlacementSettings({ ...stored, sustainMinutes: 5000 });
      expect(read.settings).toEqual(stored);
      expect(read.invalid).toEqual({
        problems: [expect.stringContaining('sustainMinutes')],
        exclusionsReadable: true,
      });
    });

    it('falls back on both ratios when they no longer fit together, and keeps the exclusions', () => {
      const read = readStoredPlacementSettings({ ...stored, triggerRatio: 1.1 });
      expect(read.settings).toEqual(stored);
      expect(read.invalid?.problems).toEqual([expect.stringContaining('resolveRatio')]);
      expect(read.invalid?.exclusionsReadable).toBe(true);
    });

    it('says the exclusions cannot be read when one of them does not validate', () => {
      const read = readStoredPlacementSettings({ ...stored, excludedSlots: [5, 99999] });
      expect(read.settings.excludedShardIds).toEqual(['n1']);
      expect(read.invalid).toEqual({
        problems: [expect.stringContaining('excludedSlots.1')],
        exclusionsReadable: false,
      });
    });

    it('says the exclusions cannot be read from a document that is not JSON or not an object', () => {
      for (const garbage of ['{not json', '"policy"', '[1]', 7]) {
        expect(readStoredPlacementSettings(garbage)).toEqual({
          settings: DEFAULT_PLACEMENT_SETTINGS,
          invalid: { problems: [expect.any(String)], exclusionsReadable: false },
        });
      }
    });
  });

  describe('excluded primaries', () => {
    const nodes = [
      { id: 'p1', master: '-' },
      { id: 'r1', master: 'p1' },
      { id: 'p2', master: '-' },
      { id: 'old', master: 'p2' },
    ];

    it('excludes the primary of every node listed, so a failover keeps the shard excluded', () => {
      expect(excludedPrimaryIds(['p1'], nodes).sort()).toEqual(['p1']);
      expect(excludedPrimaryIds(['r1'], nodes).sort()).toEqual(['p1', 'r1']);
      expect(excludedPrimaryIds(['old'], nodes).sort()).toEqual(['old', 'p2']);
    });

    it('keeps a node it does not see', () => {
      expect(excludedPrimaryIds(['gone'], nodes)).toEqual(['gone']);
    });
  });

  describe('excluded shard nodes', () => {
    const nodes = [
      { id: 'p1', master: '-' },
      { id: 'r1', master: 'p1' },
      { id: 'r2', master: 'p1' },
      { id: 'p2', master: '-' },
      { id: 'r3', master: 'p2' },
    ];

    it('adds every node of the shard of each listed node', () => {
      expect(excludedShardNodeIds(['p1'], nodes)).toEqual(['p1', 'r1', 'r2']);
      expect(excludedShardNodeIds(['r3'], nodes)).toEqual(['r3', 'p2']);
    });

    it('keeps an ID that is not in the topology as given', () => {
      expect(excludedShardNodeIds(['gone', 'r1'], nodes)).toEqual(['gone', 'r1', 'p1', 'r2']);
    });

    it('keeps the shard excluded when its old primary is down after a failover', () => {
      const stored = excludedShardNodeIds(['p1'], nodes);
      const afterFailover = [
        { id: 'p1', master: '-' },
        { id: 'r1', master: '-' },
        { id: 'r2', master: 'r1' },
        { id: 'p2', master: '-' },
        { id: 'r3', master: 'p2' },
      ];
      expect(excludedPrimaryIds(stored, afterFailover)).toContain('r1');
      expect(excludedPrimaryIds(['p1'], afterFailover)).not.toContain('r1');
    });
  });
});
