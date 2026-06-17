import type { Reader } from './types';

// Reader model. Defaults to gpt-5.4; override with LONGMEMEVAL_READER_MODEL to
// run a like-for-like comparison config (e.g. gpt-4o) without editing the default.
const CHAT_MODEL = process.env.LONGMEMEVAL_READER_MODEL ?? 'gpt-5.4';

/**
 * GPT-5-tier reasoning models reject a non-default `temperature`; callers must
 * omit it for those models and keep deterministic `temperature: 0` elsewhere.
 */
function isGpt5Tier(model: string): boolean {
  return /^gpt-5/i.test(model);
}

/** Mock reader: echo the top retrieved chunk's text as the answer. */
export function createMockReader(): Reader {
  return {
    name: 'mock-top-hit',
    answer: async (_question: string, contexts: string[]) => contexts[0] ?? '',
  };
}

async function chat(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  // Deterministic grading where the model allows it; GPT-5-tier models reject a
  // non-default temperature, so omit the field and let the API default stand.
  if (!isGpt5Tier(model)) {
    body.temperature = 0;
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI chat failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return json.choices[0].message.content.trim();
}

/** Real reader: answer the question from retrieved context. */
export function createOpenAIReader(apiKey: string): Reader {
  return {
    name: `openai:${CHAT_MODEL}`,
    answer: async (question: string, contexts: string[]) => {
      const system =
        'You answer questions about a user from the provided conversation excerpts. ' +
        'Answer concisely. ' +
        'For factual questions, give the answer stated in the excerpts; if the excerpts do not ' +
        'contain it, say "I don\'t know". ' +
        'For questions asking for a recommendation, suggestion, advice, or tips, infer and give a ' +
        'recommendation grounded in what the excerpts reveal about this user\'s preferences, ' +
        'context, and history. Base the recommendation only on preferences and signals actually ' +
        'present in the excerpts — do not invent preferences or recommend from general knowledge ' +
        'unsupported by the excerpts. If the excerpts reveal nothing relevant to the request, ' +
        'say "I don\'t know".';
      const user = `Conversation excerpts:\n${contexts
        .map((c, i) => `[${i + 1}] ${c}`)
        .join('\n\n')}\n\nQuestion: ${question}\nAnswer:`;
      return chat(apiKey, CHAT_MODEL, system, user);
    },
  };
}

export { chat };
