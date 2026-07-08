import {
  BulkDeleteMode,
  BulkDeleteParams,
  BulkDeleteProgress,
  BulkDeleteRequestInput,
  BulkDeleteRunHooks,
  NodeProgress,
  ScanTarget,
} from './types';

/** SCAN COUNT hint per batch when the caller doesn't specify one. */
export const DEFAULT_COUNT = 500;
export const MIN_COUNT = 1;
export const MAX_COUNT = 10_000;

/** Keys retained as a preview sample (dry-run) by default. */
export const DEFAULT_SAMPLE_LIMIT = 100;

export const MIN_BATCH_PAUSE_MS = 0;
export const MAX_BATCH_PAUSE_MS = 60_000;

/**
 * Default cap applied to a dry-run preview so a huge keyspace doesn't turn a
 * preview into a full walk. Reported back via `truncated` so the UI can show
 * "N+ keys". Execute runs default to unbounded (Infinity) unless the caller
 * sets maxKeys.
 */
export const DEFAULT_PREVIEW_MAX_KEYS = 10_000;
export const DEFAULT_PREVIEW_SAMPLE_LIMIT = 50;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * True when a glob pattern matches every key — i.e. it is one or more '*' with
 * nothing else. These require explicit confirmDeleteAll so a stray '*' can't
 * wipe a keyspace by accident. A pattern like 'user:*' is NOT catch-all.
 */
export function matchesEverything(pattern: string): boolean {
  return /^\*+$/.test(pattern);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export class BulkDeleteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkDeleteValidationError';
  }
}

/**
 * Normalize and validate a raw request into engine params. Throws
 * BulkDeleteValidationError on anything the caller must fix (empty pattern,
 * unconfirmed catch-all). Everything else is clamped to safe bounds.
 */
export function normalizeBulkDeleteParams(
  input: BulkDeleteRequestInput,
  mode: BulkDeleteMode,
): BulkDeleteParams {
  const match = (input.match ?? '').trim();
  if (match.length === 0) {
    throw new BulkDeleteValidationError('A non-empty match pattern is required.');
  }
  if (matchesEverything(match) && !input.confirmDeleteAll) {
    throw new BulkDeleteValidationError(
      `Refusing to run catch-all pattern "${match}" without confirmDeleteAll. This would delete every key.`,
    );
  }

  const type = input.type?.trim() || undefined;
  const count = clampInt(input.count, MIN_COUNT, MAX_COUNT, DEFAULT_COUNT);
  const batchPauseMs = clampInt(
    input.batchPauseMs,
    MIN_BATCH_PAUSE_MS,
    MAX_BATCH_PAUSE_MS,
    MIN_BATCH_PAUSE_MS,
  );

  // Preview is bounded by default; execute is unbounded unless capped.
  const defaultMaxKeys = mode === 'dry-run' ? DEFAULT_PREVIEW_MAX_KEYS : Infinity;
  const maxKeys =
    input.maxKeys !== undefined && Number.isFinite(input.maxKeys) && input.maxKeys > 0
      ? Math.trunc(input.maxKeys)
      : defaultMaxKeys;

  const sampleLimit = mode === 'dry-run' ? DEFAULT_PREVIEW_SAMPLE_LIMIT : DEFAULT_SAMPLE_LIMIT;

  return { match, type, count, mode, maxKeys, batchPauseMs, sampleLimit };
}

export function createBulkDeleteProgress(
  mode: BulkDeleteMode,
  nodesTotal: number,
): BulkDeleteProgress {
  return {
    mode,
    matched: 0,
    deleted: 0,
    batches: 0,
    nodesTotal,
    nodesDone: 0,
    truncated: false,
    cancelled: false,
    sampleKeys: [],
    perNode: [],
  };
}

/**
 * Walk each target's keyspace with SCAN (MATCH/COUNT[/TYPE]) and, in execute
 * mode, UNLINK matched keys in batches. Pure over the ScanTarget abstraction:
 * no NestJS, no iovalkey. Stops cleanly on cancel or when maxKeys is reached.
 *
 * The passed-in `progress` object (if any) is mutated in place so an owning job
 * can expose a live reference; otherwise a fresh one is created and returned.
 */
export async function runBulkDelete(
  targets: ScanTarget[],
  params: BulkDeleteParams,
  hooks: BulkDeleteRunHooks = {},
  progress: BulkDeleteProgress = createBulkDeleteProgress(params.mode, targets.length),
): Promise<BulkDeleteProgress> {
  const sleep = hooks.sleep ?? defaultSleep;
  const isCancelled = hooks.isCancelled ?? (() => false);
  progress.nodesTotal = targets.length;

  for (const target of targets) {
    const node: NodeProgress = {
      node: target.name,
      matched: 0,
      deleted: 0,
      batches: 0,
      cursorDone: false,
    };
    progress.perNode.push(node);

    let cursor = '0';
    let stopAll = false;

    do {
      if (isCancelled()) {
        progress.cancelled = true;
        stopAll = true;
        break;
      }

      const remaining = params.maxKeys - progress.matched;
      if (remaining <= 0) {
        progress.truncated = true;
        stopAll = true;
        break;
      }

      const result = await target.scan(cursor, {
        match: params.match,
        count: params.count,
        type: params.type,
      });
      cursor = result.cursor;

      let keys = result.keys;
      if (keys.length > remaining) {
        keys = keys.slice(0, remaining);
        progress.truncated = true;
      }

      if (keys.length > 0) {
        progress.matched += keys.length;
        node.matched += keys.length;
        for (const key of keys) {
          if (progress.sampleKeys.length >= params.sampleLimit) break;
          progress.sampleKeys.push(key);
        }

        if (params.mode === 'execute') {
          const removed = await target.unlink(keys);
          progress.deleted += removed;
          node.deleted += removed;
        }

        progress.batches += 1;
        node.batches += 1;
        hooks.onProgress?.(progress);

        // Pace only between real work, never after the final batch of a walk.
        if (params.batchPauseMs > 0 && cursor !== '0') {
          await sleep(params.batchPauseMs);
        }
      }

      if (progress.truncated && progress.matched >= params.maxKeys) {
        stopAll = true;
        break;
      }
    } while (cursor !== '0');

    node.cursorDone = cursor === '0' && !stopAll;
    if (node.cursorDone) progress.nodesDone += 1;

    if (stopAll) break;
  }

  return progress;
}
