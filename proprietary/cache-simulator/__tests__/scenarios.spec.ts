import { mulberry32, SCENARIOS } from '../../../apps/api/scripts/cache-simulator/scenarios';

describe('validation scenarios', () => {
  it('defines the research scenarios with their tolerances', () => {
    expect(SCENARIOS.map((scenario) => [scenario.name, scenario.tolerance, scenario.runs])).toEqual([
      ['homogeneous-small', 0.05, 10],
      ['homogeneous-large', 0.05, 10],
      ['mixed', 0.05, 10],
      ['pareto', 0.1, 10],
      ['ttl-mix', 0.05, 10],
      ['rare-giant', null, 10],
      ['scale-500k', 0.05, 3],
    ]);
  });

  it('is reproducible for a seed', () => {
    const first = [...SCENARIOS[2].generate(7)].slice(0, 50);
    const second = [...SCENARIOS[2].generate(7)].slice(0, 50);
    expect(first).toEqual(second);
    expect([...SCENARIOS[2].generate(8)].slice(0, 50)).not.toEqual(first);
  });

  it('gives half the ttl-mix keys a TTL', () => {
    const commands = [...SCENARIOS[4].generate(1)];
    const withTtl = commands.filter((command) => command.ttlSeconds !== undefined).length;
    expect(withTtl / commands.length).toBeCloseTo(0.5, 1);
  });

  it('produces values in [0, 1) from the PRNG', () => {
    const next = mulberry32(42);
    for (let index = 0; index < 1000; index++) {
      const value = next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('places exactly one dominating key in rare-giant', () => {
    const sizes = [...SCENARIOS[5].generate(3)].map((command) => (command.value as string).length);
    expect(sizes.filter((size) => size > 100)).toEqual([64 * 1024 * 1024]);
    expect(sizes).toHaveLength(50_000);
  });
});
