import { parseLatencyStatsSection } from '../latencystats-parser';

describe('parseLatencyStatsSection', () => {
  it('parses per-command percentiles in microseconds', () => {
    const samples = parseLatencyStatsSection({
      latency_percentiles_usec_get: 'p50=0.001,p99=1.003,p99.9=4.015',
      latency_percentiles_usec_hmget: 'p50=10.5,p99=1500.25,p99.9=9000',
    });

    const byCommand = Object.fromEntries(samples.map((s) => [s.command, s]));
    expect(samples).toHaveLength(2);
    expect(byCommand.get).toEqual({
      command: 'get',
      p50Us: 0.001,
      p99Us: 1.003,
      p999Us: 4.015,
    });
    expect(byCommand.hmget.p99Us).toBe(1500.25);
  });

  it('handles subcommands like cluster|slots', () => {
    const samples = parseLatencyStatsSection({
      'latency_percentiles_usec_cluster|slots': 'p50=100,p99=250,p99.9=400',
    });

    expect(samples).toHaveLength(1);
    expect(samples[0].command).toBe('cluster|slots');
  });

  it('defaults missing p50/p99.9 to 0 (custom latency-tracking-info-percentiles)', () => {
    const samples = parseLatencyStatsSection({
      latency_percentiles_usec_set: 'p99=42.5',
    });

    expect(samples).toEqual([{ command: 'set', p50Us: 0, p99Us: 42.5, p999Us: 0 }]);
  });

  it('skips commands without a p99 value', () => {
    const samples = parseLatencyStatsSection({
      latency_percentiles_usec_set: 'p50=1,p99.9=10',
      latency_percentiles_usec_get: 'p50=1,p99=2,p99.9=10',
    });

    expect(samples).toHaveLength(1);
    expect(samples[0].command).toBe('get');
  });

  it('ignores non-latency keys and returns [] for empty/absent sections', () => {
    expect(parseLatencyStatsSection(undefined)).toEqual([]);
    expect(parseLatencyStatsSection({})).toEqual([]);
    expect(
      parseLatencyStatsSection({ some_other_key: 'p50=1,p99=2' }),
    ).toEqual([]);
  });
});
