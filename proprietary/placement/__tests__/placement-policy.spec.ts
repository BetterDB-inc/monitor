import {
  DEFAULT_PLACEMENT_SETTINGS,
  placementSettingsOf,
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

  describe('reading stored settings', () => {
    it('reads nothing stored as the defaults', () => {
      expect(placementSettingsOf(null)).toEqual(DEFAULT_PLACEMENT_SETTINGS);
    });

    it('fills fields a stored document is missing from the defaults', () => {
      expect(placementSettingsOf({ sustainMinutes: 45 })).toEqual({
        ...DEFAULT_PLACEMENT_SETTINGS,
        sustainMinutes: 45,
      });
    });

    it('reads a stored document that no longer validates as the defaults', () => {
      expect(placementSettingsOf({ resolveRatio: 3 })).toEqual(DEFAULT_PLACEMENT_SETTINGS);
      expect(placementSettingsOf('garbage')).toEqual(DEFAULT_PLACEMENT_SETTINGS);
    });
  });
});
