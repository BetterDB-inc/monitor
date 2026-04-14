import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  CheckpointPendingWrite,
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
 *   {name}:session:{thread_id}:writes:{checkpoint_id}|{task_id}|{channel}|{idx} = JSON(value)
 *
 * Known limitations:
 * - list() loads all checkpoint data for a thread into memory before filtering.
 *   For threads with thousands of large checkpoints, this causes memory pressure
 *   even when limit: 1. For typical agent deployments (hundreds of checkpoints),
 *   this is acceptable. If you have millions of checkpoints per thread, consider
 *   using langgraph-checkpoint-redis with Redis 8+ instead.
 * - getTuple() calls getAll() to fetch pending writes, which retrieves all session
 *   fields for the thread and refreshes their TTL. This is wasteful for threads with
 *   many checkpoints but acceptable for typical agent workloads.
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

    let tuple: CheckpointTuple;
    try {
      tuple = JSON.parse(data);
    } catch {
      return undefined;
    }

    const resolvedId = checkpointId ?? tuple.checkpoint?.id;
    if (resolvedId) {
      const all = await this.cache.session.getAll(threadId);
      const pendingWrites = this.extractPendingWrites(all, resolvedId);
      if (pendingWrites.length > 0) {
        tuple.pendingWrites = pendingWrites;
      }
    }

    return tuple;
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Record<string, number | string>,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string;
    const checkpointId = checkpoint.id;

    // Store newVersions alongside the tuple for version tracking and conflict detection
    const storedData = {
      config: {
        ...config,
        configurable: { ...config.configurable, checkpoint_id: checkpointId },
      },
      checkpoint,
      metadata,
      newVersions, // Preserve for advanced workflows that need version-based filtering
    };
    const serialized = JSON.stringify(storedData);

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
    // URL-encode taskId and channel to safely handle any characters including delimiters.
    for (let i = 0; i < writes.length; i++) {
      const [channel, value] = writes[i];
      const encodedTaskId = encodeURIComponent(taskId);
      const encodedChannel = encodeURIComponent(channel);
      const field = `writes:${checkpointId}|${encodedTaskId}|${encodedChannel}|${i}`;
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
          const tuple: CheckpointTuple = JSON.parse(value);
          if (tuple.checkpoint?.id) {
            const pendingWrites = this.extractPendingWrites(all, tuple.checkpoint.id);
            if (pendingWrites.length > 0) {
              tuple.pendingWrites = pendingWrites;
            }
          }
          checkpoints.push(tuple);
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

  /**
   * Reconstruct CheckpointPendingWrite tuples from session fields matching
   * the key pattern: writes:{checkpointId}|{encodedTaskId}|{encodedChannel}|{idx}
   * TaskId and channel are URL-encoded to safely handle any characters.
   */
  private extractPendingWrites(
    all: Record<string, string>,
    checkpointId: string,
  ): CheckpointPendingWrite[] {
    const prefix = `writes:${checkpointId}|`;
    const pendingWrites: CheckpointPendingWrite[] = [];

    for (const [field, rawValue] of Object.entries(all)) {
      if (!field.startsWith(prefix)) continue;

      const rest = field.slice(prefix.length);
      const parts = rest.split('|');

      // Expect exactly 3 parts: encodedTaskId, encodedChannel, idx
      if (parts.length !== 3) continue;

      const taskId = decodeURIComponent(parts[0]);
      const channel = decodeURIComponent(parts[1]);

      try {
        const value = JSON.parse(rawValue);
        pendingWrites.push([taskId, channel, value]);
      } catch {
        /* skip corrupt entries */
      }
    }

    return pendingWrites;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.cache.session.destroyThread(threadId);
  }
}
