import { parseCommandStatsSection } from '../commandstats-parser';

describe('parseCommandStatsSection', () => {
  it('parses a single cmdstat line into all fields', () => {
    const result = parseCommandStatsSection({
      'cmdstat_get': 'calls=100,usec=500,usec_per_call=5.00,rejected_calls=2,failed_calls=1',
    });

    expect(result).toEqual([
      {
        command: 'get',
        calls: 100,
        usec: 500,
        usecPerCall: 5,
        rejectedCalls: 2,
        failedCalls: 1,
      },
    ]);
  });

  it('parses multiple commands and lowercases names', () => {
    const result = parseCommandStatsSection({
      'cmdstat_GET': 'calls=100,usec=500,usec_per_call=5.00',
      'cmdstat_FT.SEARCH': 'calls=25,usec=250000,usec_per_call=10000.00,rejected_calls=0,failed_calls=3',
    });

    const byCommand = Object.fromEntries(result.map((s) => [s.command, s]));
    expect(byCommand.get).toMatchObject({ calls: 100, usec: 500, usecPerCall: 5 });
    expect(byCommand['ft.search']).toMatchObject({
      calls: 25,
      usec: 250000,
      usecPerCall: 10000,
      failedCalls: 3,
    });
  });

  it('ignores keys that do not start with cmdstat_', () => {
    const result = parseCommandStatsSection({
      'cmdstat_get': 'calls=10,usec=50',
      'latencystats_dummy': 'should be ignored',
      'some_noise': 'ignored',
    });

    expect(result.map((s) => s.command)).toEqual(['get']);
  });

  it('defaults missing numeric fields to 0', () => {
    const [sample] = parseCommandStatsSection({
      'cmdstat_get': 'calls=50',
    });

    expect(sample).toEqual({
      command: 'get',
      calls: 50,
      usec: 0,
      usecPerCall: 0,
      rejectedCalls: 0,
      failedCalls: 0,
    });
  });

  it('returns an empty array for an empty or missing section', () => {
    expect(parseCommandStatsSection({})).toEqual([]);
    expect(parseCommandStatsSection(undefined)).toEqual([]);
  });
});
