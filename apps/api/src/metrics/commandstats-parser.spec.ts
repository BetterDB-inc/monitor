import { parseCommandStatsSection } from './commandstats-parser';

describe('parseCommandStatsSection', () => {
  it('parses a single cmdstat line into calls/usec', () => {
    const result = parseCommandStatsSection({
      'cmdstat_get': 'calls=100,usec=500,usec_per_call=5.00,rejected_calls=0,failed_calls=0',
    });

    expect(result).toEqual({
      get: { calls: 100, usec: 500 },
    });
  });

  it('parses multiple commands and lowercases names', () => {
    const result = parseCommandStatsSection({
      'cmdstat_GET': 'calls=100,usec=500,usec_per_call=5.00',
      'cmdstat_FT.SEARCH': 'calls=25,usec=250000,usec_per_call=10000.00',
    });

    expect(result.get).toEqual({ calls: 100, usec: 500 });
    expect(result['ft.search']).toEqual({ calls: 25, usec: 250000 });
  });

  it('ignores keys that do not start with cmdstat_', () => {
    const result = parseCommandStatsSection({
      'cmdstat_get': 'calls=10,usec=50',
      'latencystats_dummy': 'should be ignored',
      'some_noise': 'ignored',
    });

    expect(Object.keys(result)).toEqual(['get']);
  });

  it('defaults missing numeric fields to 0', () => {
    const result = parseCommandStatsSection({
      'cmdstat_get': 'calls=50',
    });

    expect(result.get).toEqual({ calls: 50, usec: 0 });
  });

  it('returns empty object for an empty or missing section', () => {
    expect(parseCommandStatsSection({})).toEqual({});
    expect(parseCommandStatsSection(undefined)).toEqual({});
  });
});
