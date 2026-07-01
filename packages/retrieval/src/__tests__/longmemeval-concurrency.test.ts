import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../eval/longmemeval/concurrency';
import { consolidateRecordFacts } from '../../eval/longmemeval/facts';
import type { FactExtractor } from '../../eval/longmemeval/facts';
import type { LmeRecord } from '../../eval/longmemeval/types';

function recordWithSessions(count: number): LmeRecord {
  const sessions = Array.from({ length: count }, (_, i) => [
    { role: 'user' as const, content: `session ${i} content` },
  ]);
  return {
    question_id: 'q',
    question_type: 't',
    question: '?',
    answer: 'a',
    haystack_session_ids: Array.from({ length: count }, (_, i) => `S${i}`),
    haystack_dates: Array.from({ length: count }, (_, i) => `2026-01-0${i + 1}`),
    haystack_sessions: sessions,
    answer_session_ids: ['S0'],
  };
}

describe('mapWithConcurrency', () => {
  it('preserves input order and returns every result', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('runs concurrently but never exceeds the limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    await mapWithConcurrency(items, 3, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});

describe('consolidateRecordFacts bounded concurrency', () => {
  it('extracts sessions in parallel up to the limit, one call per session', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const extract: FactExtractor = async (_session, meta) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return [{ subject: `topic_${meta.sessionId}`, statement: 'x' }];
    };

    const { chunks, llmCalls } = await consolidateRecordFacts(recordWithSessions(6), extract, 3);

    expect(llmCalls).toBe(6);
    expect(chunks).toHaveLength(6);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});
