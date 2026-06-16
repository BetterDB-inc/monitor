import type { Judge } from './types';
import { chat } from './reader';

const JUDGE_MODEL = 'gpt-5.5';

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
      if (g.length === 0) return false;
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
      return /correct/i.test(verdict) && !/incorrect/i.test(verdict);
    },
  };
}
