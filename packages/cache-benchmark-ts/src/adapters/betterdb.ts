import { SemanticCache } from '@betterdb/semantic-cache';
import { Redis as Valkey } from 'iovalkey';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import OpenAI from 'openai';
import { CacheAdapter } from './base.js';
import type { CheckResult, AdapterMode } from '../types.js';

const UNCERTAINTY_BAND = 0.05;
const RERANK_K = 3;
const JUDGE_MODEL = 'gpt-4o-mini';
const JUDGE_TIMEOUT_MS = 5000;

// Autotune: poll Monitor every N checks
const AUTOTUNE_POLL_INTERVAL = 100;
const AUTOTUNE_THRESHOLD_MIN = 0.02;
const AUTOTUNE_THRESHOLD_MAX = 0.30;

interface AutotuneConfig {
  monitorUrl: string;
  token: string;
  instanceId: string;
  connectionId: string;
}

export class BetterDBAdapter extends CacheAdapter {
  private cache!: SemanticCache;
  private client!: Valkey;
  private openai: OpenAI | null = null;
  private checkCount = 0;
  private currentThreshold: number;
  private autotuneConfig: AutotuneConfig | null = null;
  private readonly cacheName: string;

  constructor(threshold: number, embeddingModel: string, redisUrl: string, mode: AdapterMode) {
    super(threshold, embeddingModel, redisUrl, mode);
    this.currentThreshold = threshold;
    this.cacheName = `benchmark_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  get name(): string {
    return 'betterdb';
  }

  get finalThreshold(): number {
    return this.currentThreshold;
  }

  enabledFeatures(): string[] {
    const features: string[] = ['cosine-distance threshold'];
    if (this.mode === 'local' || this.mode === 'full' || this.mode === 'autotune-full') {
      features.push(`k=${RERANK_K} keyword-overlap rerank`);
    }
    if (this.mode === 'full' || this.mode === 'autotune-full') {
      features.push(`LLM-as-judge (${JUDGE_MODEL}) on uncertain hits`);
    }
    if (this.mode === 'autotune' || this.mode === 'autotune-full') {
      features.push('Monitor-driven threshold autotuning');
    }
    return features;
  }

  override async initialize(): Promise<void> {
    this.client = new Valkey(this.redisUrl);
    const embedFn = await this.buildEmbedFn();

    this.cache = new SemanticCache({
      client: this.client as never,
      name: this.cacheName,
      embedFn,
      defaultThreshold: this.threshold,
      uncertaintyBand: UNCERTAINTY_BAND,
      discovery: { enabled: false },
      configRefresh: {
        enabled: this.mode === 'autotune' || this.mode === 'autotune-full',
        intervalMs: 5000,
      },
      embeddingCache: { enabled: true },
      analytics: { disabled: true },
    });
    await this.cache.initialize();

    if (this.mode === 'full' || this.mode === 'autotune-full') {
      this.openai = new OpenAI();
    }

    if (this.mode === 'autotune' || this.mode === 'autotune-full') {
      this.autotuneConfig = this.readAutotuneEnv();
    }
  }

  async store(prompt: string, response: string): Promise<void> {
    await this.cache.store(prompt, response);
  }

  async check(prompt: string): Promise<CheckResult> {
    this.checkCount++;

    // Autotune: periodically poll Monitor for threshold recommendation
    if (this.autotuneConfig && this.checkCount % AUTOTUNE_POLL_INTERVAL === 0) {
      await this.pollAutotune();
    }

    const useRerank = this.mode === 'local' || this.mode === 'full' || this.mode === 'autotune-full';
    const useJudge = this.mode === 'full' || this.mode === 'autotune-full';

    const result = await this.cache.check(prompt, {
      rerank: useRerank ? { k: RERANK_K, rerankFn: this.rerankFn.bind(this) } : undefined,
      judge: useJudge
        ? {
            judgeFn: this.judgeFn.bind(this),
            onError: 'accept',
            timeoutMs: JUDGE_TIMEOUT_MS,
          }
        : undefined,
    });

    return {
      hit: result.hit,
      similarityScore: result.similarity ?? null,
    };
  }

  async clear(): Promise<void> {
    if (this.cache) {
      await this.cache.flush();
      await this.cache.initialize();
    }
  }

  override async close(): Promise<void> {
    if (this.cache) {
      await this.cache.shutdown();
    }
    if (this.client) {
      this.client.disconnect();
    }
  }

  // --- Rerank: 70% cosine similarity + 30% keyword overlap ---
  private async rerankFn(
    query: string,
    candidates: Array<{ response: string; similarity: number }>,
  ): Promise<number> {
    const queryWords = new Set(tokenize(query));
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const responseWords = tokenize(c.response);
      const overlap =
        responseWords.length === 0
          ? 0
          : responseWords.filter((w) => queryWords.has(w)).length / responseWords.length;
      // similarity is cosine distance (lower = more similar), invert for scoring
      const cosineSim = 1 - c.similarity;
      const combined = 0.7 * cosineSim + 0.3 * overlap;
      if (combined > bestScore) {
        bestScore = combined;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // --- Judge: gpt-4o-mini semantic equivalence check ---
  private async judgeFn(input: {
    prompt: string;
    response: string;
    similarity: number;
    threshold: number;
  }): Promise<boolean> {
    if (!this.openai) return true;

    const completion = await this.openai.chat.completions.create({
      model: JUDGE_MODEL,
      max_tokens: 10,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are a semantic equivalence judge. Given a new query and a cached response, ' +
            'determine if the cached response adequately answers the new query. ' +
            'Reply with exactly YES or NO.',
        },
        {
          role: 'user',
          content: `New query: ${input.prompt}\nCached response: ${input.response}\nSimilarity score: ${input.similarity.toFixed(4)}`,
        },
      ],
    });

    const answer = completion.choices[0]?.message?.content?.trim().toUpperCase() ?? '';
    return answer.includes('YES');
  }

  // --- Autotune: poll Monitor API ---
  private async pollAutotune(): Promise<void> {
    const cfg = this.autotuneConfig!;
    try {
      // Get threshold recommendation
      const recUrl =
        `${cfg.monitorUrl}/api/cache/${cfg.instanceId}/connections/${cfg.connectionId}` +
        `/caches/${encodeURIComponent(this.cacheName)}/threshold-recommendation`;
      const recRes = await fetch(recUrl, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (!recRes.ok) return;
      const rec = (await recRes.json()) as {
        recommendation: string;
        recommended_threshold?: number;
      };

      if (
        (rec.recommendation === 'tighten_threshold' || rec.recommendation === 'loosen_threshold') &&
        rec.recommended_threshold != null
      ) {
        const newThreshold = Math.max(
          AUTOTUNE_THRESHOLD_MIN,
          Math.min(AUTOTUNE_THRESHOLD_MAX, rec.recommended_threshold),
        );

        // Create proposal
        const proposalUrl =
          `${cfg.monitorUrl}/api/cache/${cfg.instanceId}/connections/${cfg.connectionId}/proposals`;
        const proposalRes = await fetch(proposalUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            cache_name: this.cacheName,
            cache_type: 'semantic_cache',
            proposal_type: 'threshold_adjust',
            proposal_payload: {
              category: 'all',
              current_threshold: this.currentThreshold,
              new_threshold: newThreshold,
            },
          }),
        });
        if (!proposalRes.ok) return;
        const proposal = (await proposalRes.json()) as { id: string };

        // Auto-approve
        const approveUrl = `${proposalUrl}/${proposal.id}/approve`;
        const approveRes = await fetch(approveUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.token}` },
        });
        if (approveRes.ok) {
          this.currentThreshold = newThreshold;
        }
      }
    } catch {
      // Autotune poll failures are non-fatal
    }
  }

  private async buildEmbedFn(): Promise<(text: string) => Promise<number[]>> {
    // If the model looks like an OpenAI model, use the OpenAI API
    if (this.embeddingModel.startsWith('text-embedding-')) {
      const openaiClient = new OpenAI();
      return async (text: string) => {
        const res = await openaiClient.embeddings.create({
          model: this.embeddingModel,
          input: text,
        });
        return res.data[0].embedding;
      };
    }

    // Otherwise, use local sentence-transformers via @huggingface/transformers
    console.log(`  Loading local model: ${this.embeddingModel} ...`);
    const extractor: FeatureExtractionPipeline = await pipeline(
      'feature-extraction',
      this.embeddingModel,
      { dtype: 'fp32' },
    );
    console.log(`  Model loaded.`);

    return async (text: string) => {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data as Float32Array);
    };
  }

  private readAutotuneEnv(): AutotuneConfig {
    const monitorUrl = process.env.BETTERDB_URL;
    const token = process.env.BETTERDB_TOKEN;
    const instanceId = process.env.BETTERDB_INSTANCE_ID;
    const connectionId = process.env.BETTERDB_CONNECTION_ID ?? 'default';

    if (!monitorUrl || !token || !instanceId) {
      throw new Error(
        'Autotune mode requires BETTERDB_URL, BETTERDB_TOKEN, and BETTERDB_INSTANCE_ID env vars',
      );
    }

    return {
      monitorUrl: monitorUrl.replace(/\/+$/, ''),
      token,
      instanceId,
      connectionId,
    };
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 1);
}
