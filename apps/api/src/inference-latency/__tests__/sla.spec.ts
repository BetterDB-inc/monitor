import { evaluateSla, SlaState } from '../sla';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function freshState(): Map<string, SlaState> {
  return new Map();
}

describe('evaluateSla', () => {
  it('fires on the first breach for a new (connection, index)', () => {
    const state = freshState();
    const result = evaluateSla({
      connectionId: 'conn-1',
      indexName: 'idx_cache',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0,
      state,
    });
    expect(result.fired).toBe(true);
    expect(state.get('conn-1|idx_cache')).toEqual({ lastFiredAt: T0, resolved: false });
  });

  it('suppresses a repeat breach 5 min later (debounced within 10 min window)', () => {
    const state = freshState();
    evaluateSla({ connectionId: 'c', indexName: 'i', currentP99Us: 20_000, thresholdUs: 10_000, now: T0, state });
    const result = evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0 + 5 * MIN,
      state,
    });
    expect(result.fired).toBe(false);
  });

  it('re-fires a repeat breach after the debounce window (11 min later)', () => {
    const state = freshState();
    evaluateSla({ connectionId: 'c', indexName: 'i', currentP99Us: 20_000, thresholdUs: 10_000, now: T0, state });
    const result = evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0 + 11 * MIN,
      state,
    });
    expect(result.fired).toBe(true);
    expect(state.get('c|i')?.lastFiredAt).toBe(T0 + 11 * MIN);
  });

  it('isolates debounce per (connection, index) pair', () => {
    const state = freshState();
    evaluateSla({ connectionId: 'c1', indexName: 'i', currentP99Us: 20_000, thresholdUs: 10_000, now: T0, state });
    const otherPair = evaluateSla({
      connectionId: 'c2',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0 + MIN,
      state,
    });
    expect(otherPair.fired).toBe(true);
    const sameConnDifferentIndex = evaluateSla({
      connectionId: 'c1',
      indexName: 'j',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0 + MIN,
      state,
    });
    expect(sameConnDifferentIndex.fired).toBe(true);
  });

  it('marks a pair resolved when p99 drops below threshold', () => {
    const state = freshState();
    evaluateSla({ connectionId: 'c', indexName: 'i', currentP99Us: 20_000, thresholdUs: 10_000, now: T0, state });
    const ok = evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 5_000,
      thresholdUs: 10_000,
      now: T0 + 2 * MIN,
      state,
    });
    expect(ok.fired).toBe(false);
    expect(state.get('c|i')?.resolved).toBe(true);
  });

  it('re-fires immediately after resolution even within the debounce window', () => {
    const state = freshState();
    evaluateSla({ connectionId: 'c', indexName: 'i', currentP99Us: 20_000, thresholdUs: 10_000, now: T0, state });
    evaluateSla({ connectionId: 'c', indexName: 'i', currentP99Us: 5_000, thresholdUs: 10_000, now: T0 + 2 * MIN, state });
    const reBreach = evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0 + 4 * MIN,
      state,
    });
    expect(reBreach.fired).toBe(true);
    expect(state.get('c|i')).toEqual({ lastFiredAt: T0 + 4 * MIN, resolved: false });
  });

  it('does not fire on initial sub-threshold reading and stores no state', () => {
    const state = freshState();
    const result = evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 5_000,
      thresholdUs: 10_000,
      now: T0,
      state,
    });
    expect(result.fired).toBe(false);
    expect(state.has('c|i')).toBe(false);
  });
});
