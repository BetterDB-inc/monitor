import { resolveActivityConfig } from './activity-config';

describe('resolveActivityConfig', () => {
  it('defaults retention to 90 days', () => {
    expect(resolveActivityConfig({})).toEqual({ retentionDays: 90 });
  });

  it('reads ACTIVITY_RETENTION_DAYS', () => {
    expect(resolveActivityConfig({ ACTIVITY_RETENTION_DAYS: '30' })).toEqual({ retentionDays: 30 });
  });

  it('falls back to the default for a non-positive or non-numeric value', () => {
    expect(resolveActivityConfig({ ACTIVITY_RETENTION_DAYS: '0' })).toEqual({ retentionDays: 90 });
    expect(resolveActivityConfig({ ACTIVITY_RETENTION_DAYS: 'soon' })).toEqual({
      retentionDays: 90,
    });
  });
});
