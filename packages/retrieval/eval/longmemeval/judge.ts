import type { Judge } from './types';
import { chat } from './reader';

// Judge model. Defaults to gpt-5.5; override with LONGMEMEVAL_JUDGE_MODEL to run
// a like-for-like comparison config (e.g. gpt-4o) without editing the default.
const JUDGE_MODEL = process.env.LONGMEMEVAL_JUDGE_MODEL ?? 'gpt-5.5';

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mock judge: normalized substring/exact match against gold. Good enough to
 * grade the bundled fixture deterministically without a model.
 */
export function createMockJudge(): Judge {
  return {
    name: 'mock-substring',
    grade: async (_question: string, gold: string, predicted: string) => {
      const g = normalize(gold);
      const p = normalize(predicted);
      // An empty prediction (e.g. a retrieval miss leaving the reader no
      // context) must never grade correct — `g.includes('')` is always true.
      if (g.length === 0 || p.length === 0) return false;
      return p === g || p.includes(g) || g.includes(p);
    },
  };
}

/** Real judge: GPT grader returning correct/incorrect, LongMemEval-style. */
export function createOpenAIJudge(apiKey: string): Judge {
  return {
    name: `openai-judge:${JUDGE_MODEL}`,
    grade: async (question: string, gold: string, predicted: string) => {
      const system =
        'You are an impartial grader for a long-term memory QA benchmark. ' +
        'Given a question, the gold answer, and a model answer, decide whether the ' +
        'model answer is correct (conveys the same key information as the gold answer). ' +
        'Reply with exactly one word: "correct" or "incorrect".';
      const user = `Question: ${question}\nGold answer: ${gold}\nModel answer: ${predicted}\n\nVerdict:`;
      const verdict = await chat(apiKey, JUDGE_MODEL, system, user);
      const v = verdict.toLowerCase();
      // `\bcorrect\b` does not match inside "incorrect" (no word boundary), so
      // detect the verdict by whole word and reject negated/partial forms like
      // "incorrect", "not correct", or "partially correct".
      const saysCorrect = /\bcorrect\b/.test(v);
      const negated = /\bincorrect\b/.test(v) || /\b(?:not|partially|isn't)\b[\s\S]{0,20}\bcorrect\b/.test(v);
      return saysCorrect && !negated;
    },
  };
}
