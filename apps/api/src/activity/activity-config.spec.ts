import { parseActivityRetentionDays, resolveActivityConfig } from './activity-config';

describe('resolveActivityConfig', () => {
  it('defaults retention to 90 days', () => {
    expect(resolveActivityConfig({})).toEqual({
      retentionDays: 90,
      placementActionRetentionDays: 90,
    });
  });

  it('reads PLACEMENT_ACTION_RETENTION_DAYS apart from ACTIVITY_RETENTION_DAYS', () => {
    expect(
      resolveActivityConfig({
        ACTIVITY_RETENTION_DAYS: '30',
        PLACEMENT_ACTION_RETENTION_DAYS: '365',
      }),
    ).toEqual({ retentionDays: 30, placementActionRetentionDays: 365 });
    expect(resolveActivityConfig({ PLACEMENT_ACTION_RETENTION_DAYS: '1e2' })).toEqual({
      retentionDays: 90,
      placementActionRetentionDays: 90,
    });
  });

  it('reads ACTIVITY_RETENTION_DAYS', () => {
    expect(resolveActivityConfig({ ACTIVITY_RETENTION_DAYS: '30' })).toMatchObject({
      retentionDays: 30,
    });
  });

  it('falls back to the default for a non-positive or non-numeric value', () => {
    expect(resolveActivityConfig({ ACTIVITY_RETENTION_DAYS: '0' })).toMatchObject({
      retentionDays: 90,
    });
    expect(resolveActivityConfig({ ACTIVITY_RETENTION_DAYS: 'soon' })).toMatchObject({
      retentionDays: 90,
    });
  });

  it('accepts surrounding whitespace around a whole number', () => {
    expect(resolveActivityConfig({ ACTIVITY_RETENTION_DAYS: ' 30 ' })).toMatchObject({
      retentionDays: 30,
    });
  });

  it.each(['1e2', '1.5', '30days', '-5', '+30', '9007199254740993'])(
    'falls back to the default instead of truncating %s',
    (value) => {
      expect(resolveActivityConfig({ ACTIVITY_RETENTION_DAYS: value })).toMatchObject({
        retentionDays: 90,
      });
    },
  );
});

describe('parseActivityRetentionDays', () => {
  it('parses a whole positive number', () => {
    expect(parseActivityRetentionDays('100')).toBe(100);
  });

  it.each([undefined, '', '   ', '0', '1e2', '1.5', '9007199254740993'])('rejects %p', (value) => {
    expect(parseActivityRetentionDays(value)).toBeNull();
  });
});
