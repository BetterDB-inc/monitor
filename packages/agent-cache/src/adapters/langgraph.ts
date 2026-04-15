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
import { AgentCacheUsageError } from '../errors';

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
 *   {name}:session:{thread_id}:__checkpoint_latest = JSON(CheckpointTuple)
 *   {name}:session:{thread_id}:writes:{checkpoint_id}|{task_id}|{channel}|{idx} = JSON(value)
 *
 * Known limitations:
 * - list() (general path) loads all checkpoint data for a thread into memory before
 *   filtering, which refreshes TTL on all fields via getAll()'s sliding window.
 *   For threads with thousands of large checkpoints, this causes memory pressure
 *   even when limit: 1. For typical agent deployments (hundreds of checkpoints),
 *   this is acceptable. If you have millions of checkpoints per thread, consider
 *   using langgraph-checkpoint-redis with Redis 8+ instead.
 * - getTuple() and the list() limit=1 fast path use scanFieldsByPrefix() for targeted
 *   pending writes lookup without refreshing TTL on unrelated session fields.
 */
export class BetterDBSaver extends BaseCheckpointSaver {
  private cache: AgentCache;
  private static readonly LATEST_POINTER_FIELD = '__checkpoint_latest';

  constructor(opts: BetterDBSaverOptions) {
    super();
    this.cache = opts.cache;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string;
    if (!threadId) return undefined;

    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    const field = checkpointId ? `checkpoint:${checkpointId}` : BetterDBSaver.LATEST_POINTER_FIELD;

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
      const writeFields = await this.cache.session.scanFieldsByPrefix(
        threadId,
        `writes:${encodeURIComponent(resolvedId)}|`,
      );
      const pendingWrites = this.extractPendingWrites(writeFields, resolvedId);
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
    _newVersions: Record<string, number | string>,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      throw new AgentCacheUsageError('put() requires config.configurable.thread_id');
    }
    const checkpointId = checkpoint.id;

    // Note: newVersions is not stored - no current consumer needs it.
    // If version-based conflict detection is needed, add it back with a concrete use case.
    const storedData = {
      config: {
        ...config,
        configurable: { ...config.configurable, checkpoint_id: checkpointId },
      },
      checkpoint,
      metadata,
    };
    const serialized = JSON.stringify(storedData);

    // Write checkpoint first, then update latest pointer sequentially.
    // If the latest write succeeds but checkpoint didn't, getTuple() and list(limit:1)
    // would reference a non-existent checkpoint. Sequential order ensures latest
    // only points to a checkpoint that already exists.
    await this.cache.session.set(threadId, `checkpoint:${checkpointId}`, serialized);
    await this.cache.session.set(threadId, BetterDBSaver.LATEST_POINTER_FIELD, serialized);

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
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId || !checkpointId) {
      throw new AgentCacheUsageError(
        'putWrites() requires both config.configurable.thread_id and config.configurable.checkpoint_id',
      );
    }

    // Include taskId in the storage key for deduplication per the LangGraph protocol.
    // URL-encode all components to safely handle any characters including the | delimiter.
    // Use Promise.all to write all entries in parallel (single batch of round-trips).
    const encodedCheckpointId = encodeURIComponent(checkpointId);
    const encodedTaskId = encodeURIComponent(taskId);

    await Promise.all(
      writes.map(([channel, value], i) => {
        const encodedChannel = encodeURIComponent(channel);
        const field = `writes:${encodedCheckpointId}|${encodedTaskId}|${encodedChannel}|${i}`;
        return this.cache.session.set(threadId, field, JSON.stringify(value));
      })
    );
  }

  async *list(
    config: RunnableConfig,
    options?: { limit?: number; before?: RunnableConfig },
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string;
    if (!threadId) return;

    // Fast path: limit=1 with no before filter is the common case (fetch latest).
    // Short-circuit by reading the latest pointer directly to avoid parsing and sorting
    // all checkpoints. Uses scanFieldsByPrefix() for writes to avoid refreshing TTL on
    // unrelated session fields (getAll() has a sliding window side effect).
    if (options?.limit === 1 && !options?.before) {
      const latestData = await this.cache.session.get(threadId, BetterDBSaver.LATEST_POINTER_FIELD);
      if (latestData) {
        try {
          const tuple: CheckpointTuple = JSON.parse(latestData);
          if (tuple.checkpoint?.id) {
            const writeFields = await this.cache.session.scanFieldsByPrefix(
              threadId,
              `writes:${encodeURIComponent(tuple.checkpoint.id)}|`,
            );
            const pendingWrites = this.extractPendingWrites(writeFields, tuple.checkpoint.id);
            if (pendingWrites.length > 0) {
              tuple.pendingWrites = pendingWrites;
            }
          }
          yield tuple;
        } catch {
          /* skip corrupt entry */
        }
      }
      return;
    }

    // Get all session fields, then split into checkpoints and writes in a single pass.
    // This avoids re-scanning the entire map per checkpoint in extractPendingWrites.
    const all = await this.cache.session.getAll(threadId);
    const writeFields: Record<string, string> = {};
    const checkpoints: CheckpointTuple[] = [];

    for (const [field, value] of Object.entries(all)) {
      if (field.startsWith('writes:')) {
        writeFields[field] = value;
      } else if (field.startsWith('checkpoint:')) {
        try {
          const tuple: CheckpointTuple = JSON.parse(value);
          checkpoints.push(tuple);
        } catch {
          /* skip corrupt entries */
        }
      }
    }

    // Attach pending writes from the pre-filtered writes map
    for (const tuple of checkpoints) {
      if (tuple.checkpoint?.id) {
        const pendingWrites = this.extractPendingWrites(writeFields, tuple.checkpoint.id);
        if (pendingWrites.length > 0) {
          tuple.pendingWrites = pendingWrites;
        }
      }
    }

    // Sort by checkpoint timestamp descending.
    // Parse timestamps to ensure correct ordering regardless of format.
    checkpoints.sort((a, b) => {
      const tsA = a.checkpoint?.ts ?? '';
      const tsB = b.checkpoint?.ts ?? '';
      const dateA = new Date(tsA).getTime();
      const dateB = new Date(tsB).getTime();
      const validA = !isNaN(dateA);
      const validB = !isNaN(dateB);
      if (validA && validB) return dateB - dateA;
      // Valid date sorts before invalid (put well-formed timestamps first)
      if (validA) return -1;
      if (validB) return 1;
      // Both invalid — fall back to string comparison
      return tsB.localeCompare(tsA);
    });

    // Apply before filter
    const beforeId = options?.before?.configurable?.checkpoint_id;
    // If before checkpoint is specified but doesn't exist, return empty per LangGraph protocol
    // (before means "checkpoints older than this one" — if the reference doesn't exist, there's
    // no valid older set to return)
    if (beforeId && !checkpoints.some(t => t.checkpoint?.id === beforeId)) {
      return;
    }
    let started = !options?.before;
    let yielded = 0;
    const limit = options?.limit ?? Infinity;

    for (const tuple of checkpoints) {
      if (!started) {
        if (tuple.checkpoint?.id === beforeId) {
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
   * the key pattern: writes:{encodedCheckpointId}|{encodedTaskId}|{encodedChannel}|{idx}
   * All components are URL-encoded to safely handle any characters including the | delimiter.
   * Results are sorted by idx to preserve write ordering within a checkpoint.
   */
  private extractPendingWrites(
    all: Record<string, string>,
    checkpointId: string,
  ): CheckpointPendingWrite[] {
    // checkpointId is URL-encoded in the key
    const prefix = `writes:${encodeURIComponent(checkpointId)}|`;
    const pendingWrites: Array<{ idx: number; write: CheckpointPendingWrite }> = [];

    for (const [field, rawValue] of Object.entries(all)) {
      if (!field.startsWith(prefix)) continue;

      const rest = field.slice(prefix.length);
      const parts = rest.split('|');

      // Expect exactly 3 parts: encodedTaskId, encodedChannel, idx.
      // Safe to skip silently: all components are URL-encoded during putWrites(),
      // so literal | cannot appear inside encoded values (%7C would be used instead).
      if (parts.length !== 3) continue;

      const taskId = decodeURIComponent(parts[0]);
      const channel = decodeURIComponent(parts[1]);
      const idx = parseInt(parts[2], 10);

      try {
        const value = JSON.parse(rawValue);
        pendingWrites.push({ idx, write: [taskId, channel, value] });
      } catch {
        /* skip corrupt entries */
      }
    }

    // Sort by idx to preserve write ordering
    pendingWrites.sort((a, b) => a.idx - b.idx);

    return pendingWrites.map(p => p.write);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.cache.session.destroyThread(threadId);
  }
}
