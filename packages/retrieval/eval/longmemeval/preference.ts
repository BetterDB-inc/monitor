import type { QueryHit } from '../../src/index';
import { chat, DEFAULT_CHAT_MODEL } from './reader';
import { parseFacts } from './facts';
import type { FactExtractor } from './facts';
import { verdictIsCorrect } from './judge';
import type { Judge } from './types';

export { verdictIsCorrect } from './judge';

const EXTRACT_MODEL = process.env.LONGMEMEVAL_PREFERENCE_MODEL ?? DEFAULT_CHAT_MODEL;
const JUDGE_MODEL = process.env.LONGMEMEVAL_JUDGE_MODEL ?? 'gpt-5.5';
const DEFAULT_PROMOTE_CAP = 2;

export const PREFERENCE_ID_PREFIX = 'pref_';

// Question-derived heuristic — deliberately NOT the dataset's question_type
// label, so retrieval never sees ground-truth metadata. Recommendation-shaped
// questions are where preference evidence and the preference rubric apply.
export function isPreferenceQuestion(question: string): boolean {
  return /\b(?:recommend\w*|suggest\w*|advice|advise|tips?|ideas?)\b|\bwhat should i\b|\bwhich .{0,40}\bshould i\b/i.test(
    question,
  );
}

function isPreferenceHit(hit: QueryHit): boolean {
  return hit.id.startsWith(PREFERENCE_ID_PREFIX);
}

// Importance boost: stable-promote up to `cap` preference chunks from outside
// the top-k window into it. Nothing is dropped, the relative order of every
// other hit is preserved, and only NON-preference window hits (lowest-ranked
// first) are displaced — evicting an in-window preference chunk to admit
// another would trade away exactly the evidence the boost exists to keep.
export function promotePreferenceHits(
  hits: QueryHit[],
  k: number,
  cap: number = DEFAULT_PROMOTE_CAP,
): QueryHit[] {
  if (hits.length <= k) {
    return hits;
  }
  const window = hits.slice(0, k);
  const displaceable = window.filter((hit) => {
    return isPreferenceHit(hit) === false;
  });
  const budget = Math.min(cap, displaceable.length);
  const promoted = hits.slice(k).filter(isPreferenceHit).slice(0, budget);
  if (promoted.length === 0) {
    return hits;
  }
  const displacedIds = new Set(
    displaceable.slice(displaceable.length - promoted.length).map((hit) => {
      return hit.id;
    }),
  );
  const keep = window.filter((hit) => {
    return displacedIds.has(hit.id) === false;
  });
  const displaced = window.filter((hit) => {
    return displacedIds.has(hit.id);
  });
  const promotedIds = new Set(promoted.map((hit) => hit.id));
  const tail = hits.slice(k).filter((hit) => {
    return promotedIds.has(hit.id) === false;
  });
  return [...keep, ...promoted, ...displaced, ...tail];
}

const PREFERENCE_CUE =
  /\b(?:love|like|prefer|hate|dislike|favorite|favourite|enjoy|can't stand|cannot stand)\b/i;

export function createMockPreferenceExtractor(): FactExtractor {
  return async (session, meta) => {
    const facts = [];
    for (let i = 0; i < session.length; i++) {
      const turn = session[i];
      if (turn.role !== 'user' || PREFERENCE_CUE.test(turn.content) === false) {
        continue;
      }
      facts.push({ subject: `preference_${meta.sessionId}_${i}`, statement: turn.content });
    }
    return facts;
  };
}

export function createOpenAIPreferenceExtractor(apiKey: string): FactExtractor {
  const system =
    "Extract the user's stated preferences from the conversation session: likes, " +
    'dislikes, tastes, habits, constraints, and stylistic wishes a personal assistant ' +
    'should honor when making recommendations. Return ONLY a JSON array of objects ' +
    '{"subject","statement"} where subject is a short normalized snake_case key ' +
    '(e.g. "cuisine_preference", "travel_style") and statement is one short sentence ' +
    'describing the preference. Ignore transient or purely factual content. If none, return [].';
  return async (session) => {
    const user = session.map((turn) => `${turn.role}: ${turn.content}`).join('\n');
    const reply = await chat(apiKey, EXTRACT_MODEL, system, user);
    return parseFacts(reply);
  };
}

// The rubric validated by diag-preference.ts: grade whether the answer honors
// the user's preferences, not whether it restates the gold answer verbatim.
export function createOpenAIPreferenceJudge(apiKey: string): Judge {
  return {
    name: `openai-pref-judge:${JUDGE_MODEL}`,
    grade: async (question: string, gold: string, predicted: string) => {
      const system =
        'You are an impartial grader for a long-term memory QA benchmark. The gold answer ' +
        "describes the user's stated preferences. Decide whether the model answer is consistent " +
        'with and honors those preferences (it need not restate them verbatim; a recommendation or ' +
        'response that aligns with the preferences is correct). Reply with exactly one word: ' +
        '"correct" or "incorrect".';
      const user = `Question: ${question}\nGold answer: ${gold}\nModel answer: ${predicted}\n\nVerdict:`;
      const verdict = await chat(apiKey, JUDGE_MODEL, system, user);
      return verdictIsCorrect(verdict);
    },
  };
}

// Routes recommendation-shaped questions to the preference rubric and leaves
// every other question on the generic judge, so the rubric cannot regress the
// other question types.
export function createPreferenceAwareJudge(preference: Judge, generic: Judge): Judge {
  return {
    name: `preference-aware(${preference.name} | ${generic.name})`,
    grade: async (question: string, gold: string, predicted: string) => {
      if (isPreferenceQuestion(question)) {
        return preference.grade(question, gold, predicted);
      }
      return generic.grade(question, gold, predicted);
    },
  };
}
