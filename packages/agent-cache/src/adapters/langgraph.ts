import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentCache } from '../AgentCache';

export interface BetterDBSaverOptions {
  /** A pre-configured AgentCache instance. */
  cache: AgentCache;
}

/**
 * LangGraph checkpoint saver backed by AgentCache session storage.
 *
 * Works on vanilla Valkey 7+ with no modules. Unlike `langgraph-checkpoint-redis`,
 * this does not require Redis 8.0+, RedisJSON, or RediSearch.
 *
 * Storage layout in session tier:
 *   {name}:session:{thread_id}:checkpoint:{checkpoint_id} = JSON(CheckpointTuple)
 *   {name}:session:{thread_id}:checkpoint:latest = JSON(CheckpointTuple)
 *   {name}:session:{thread_id}:writes:{checkpoint_id}:{task_id}:{channel}:{idx} = JSON(value)
 *
 * Known limitations:
 * - list() loads all checkpoint data for a thread into memory before filtering.
 *   For threads with thousands of large checkpoints, this causes memory pressure
 *   even when limit: 1. For typical agent deployments (hundreds of checkpoints),
 *   this is acceptable. If you have millions of checkpoints per thread, consider
 *   using langgraph-checkpoint-redis with Redis 8+ instead.
 */
export class BetterDBSaver extends BaseCheckpointSaver {
  private cache: AgentCache;

  constructor(opts: BetterDBSaverOptions) {
    super();
    this.cache = opts.cache;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string;
    if (!threadId) return undefined;

    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    const field = checkpointId ? `checkpoint:${checkpointId}` : 'checkpoint:latest';

    const data = await this.cache.session.get(threadId, field);
    if (!data) return undefined;

    try {
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Record<string, number>,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string;
    const checkpointId = checkpoint.id;

    const tuple: CheckpointTuple = {
      config: {
        ...config,
        configurable: { ...config.configurable, checkpoint_id: checkpointId },
      },
      checkpoint,
      metadata,
    };
    const serialized = JSON.stringify(tuple);

    // Store specific checkpoint and update latest pointer
    await this.cache.session.set(threadId, `checkpoint:${checkpointId}`, serialized);
    await this.cache.session.set(threadId, 'checkpoint:latest', serialized);

    return {
      ...config,
      configurable: { ...config.configurable, checkpoint_id: checkpointId },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = config.configurable?.thread_id as string;
    const checkpointId = config.configurable?.checkpoint_id as string;

    // Include taskId in the storage key for deduplication per the LangGraph protocol.
    // This ensures writes from different tasks within the same checkpoint don't collide.
    for (let i = 0; i < writes.length; i++) {
      const [channel, value] = writes[i];
      const field = `writes:${checkpointId}:${taskId}:${channel}:${i}`;
      await this.cache.session.set(threadId, field, JSON.stringify(value));
    }
  }

  async *list(
    config: RunnableConfig,
    options?: { limit?: number; before?: RunnableConfig },
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string;
    if (!threadId) return;

    // Get all checkpoint fields via getAll, filter to checkpoint:* (not checkpoint:latest)
    const all = await this.cache.session.getAll(threadId);
    const checkpoints: CheckpointTuple[] = [];

    for (const [field, value] of Object.entries(all)) {
      if (field.startsWith('checkpoint:') && field !== 'checkpoint:latest') {
        try {
          checkpoints.push(JSON.parse(value));
        } catch {
          /* skip corrupt entries */
        }
      }
    }

    // Sort by checkpoint timestamp descending
    checkpoints.sort((a, b) => {
      const tsA = a.checkpoint?.ts ?? '';
      const tsB = b.checkpoint?.ts ?? '';
      return tsB.localeCompare(tsA);
    });

    // Apply before filter
    let started = !options?.before;
    let yielded = 0;
    const limit = options?.limit ?? Infinity;

    for (const tuple of checkpoints) {
      if (!started) {
        if (tuple.checkpoint?.id === options?.before?.configurable?.checkpoint_id) {
          started = true;
        }
        continue;
      }
      if (yielded >= limit) break;
      yield tuple;
      yielded++;
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.cache.session.destroyThread(threadId);
  }
}
