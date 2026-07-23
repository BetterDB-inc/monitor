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
    expect(state.get('conn-1|idx_cache')).toEqual({
      lastFiredAt: T0,
      resolved: false,
      lastP99Us: 20_000,
      lastEvaluatedAt: T0,
    });
  });

  it('suppresses a repeat breach 5 min later (debounced within 10 min window)', () => {
    const state = freshState();
    evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0,
      state,
    });
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
    evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0,
      state,
    });
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
    evaluateSla({
      connectionId: 'c1',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0,
      state,
    });
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
    evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0,
      state,
    });
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
    evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0,
      state,
    });
    evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 5_000,
      thresholdUs: 10_000,
      now: T0 + 2 * MIN,
      state,
    });
    const reBreach = evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0 + 4 * MIN,
      state,
    });
    expect(reBreach.fired).toBe(true);
    expect(state.get('c|i')).toEqual({
      lastFiredAt: T0 + 4 * MIN,
      resolved: false,
      lastP99Us: 20_000,
      lastEvaluatedAt: T0 + 4 * MIN,
    });
  });

  it('fires immediately when a raised threshold cleared the old breach and a new sample breaches it', () => {
    const state = freshState();
    evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 200,
      thresholdUs: 100,
      now: T0,
      state,
    });
    const newBreach = evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 600,
      thresholdUs: 500,
      now: T0 + 2 * MIN,
      state,
    });
    expect(newBreach.fired).toBe(true);
    expect(state.get('c|i')?.resolved).toBe(false);
    expect(state.get('c|i')?.lastFiredAt).toBe(T0 + 2 * MIN);
  });

  it('keeps the debounce window when the breach persists under an unchanged threshold', () => {
    const state = freshState();
    evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 200,
      thresholdUs: 100,
      now: T0,
      state,
    });
    const repeat = evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 250,
      thresholdUs: 100,
      now: T0 + 2 * MIN,
      state,
    });
    expect(repeat.fired).toBe(false);
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

  it('does not fire when p99 is exactly at the threshold (inclusive ceiling)', () => {
    const state = freshState();
    const result = evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 10_000,
      thresholdUs: 10_000,
      now: T0,
      state,
    });
    expect(result.fired).toBe(false);
    expect(state.has('c|i')).toBe(false);
  });

  it('marks a pair resolved when p99 returns exactly to the threshold', () => {
    const state = freshState();
    evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 20_000,
      thresholdUs: 10_000,
      now: T0,
      state,
    });
    evaluateSla({
      connectionId: 'c',
      indexName: 'i',
      currentP99Us: 10_000,
      thresholdUs: 10_000,
      now: T0 + MIN,
      state,
    });
    expect(state.get('c|i')?.resolved).toBe(true);
  });
});
