import {
  BulkDeleteValidationError,
  DEFAULT_COUNT,
  DEFAULT_PREVIEW_MAX_KEYS,
  MAX_BATCH_PAUSE_MS,
  MAX_COUNT,
  matchesEverything,
  normalizeBulkDeleteParams,
  runBulkDelete,
} from '../bulk-delete-engine';
import { BulkDeleteParams, ScanTarget } from '../types';

type Page = [cursor: string, keys: string[]];

function makeTarget(name: string, pages: Page[]) {
  let idx = 0;
  const scan = jest.fn(async () => {
    const page = pages[idx] ?? (['0', []] as Page);
    idx += 1;
    return { cursor: page[0], keys: page[1] };
  });
  const unlink = jest.fn(async (keys: string[]) => keys.length);
  const target: ScanTarget = { name, scan, unlink };
  return { target, scan, unlink };
}

function params(overrides: Partial<BulkDeleteParams> = {}): BulkDeleteParams {
  return {
    match: '*',
    type: undefined,
    count: 500,
    mode: 'execute',
    maxKeys: Infinity,
    batchPauseMs: 0,
    sampleLimit: 100,
    ...overrides,
  };
}

describe('matchesEverything', () => {
  it.each(['*', '**', '***'])('treats "%s" as catch-all', (p) => {
    expect(matchesEverything(p)).toBe(true);
  });

  it.each(['user:*', 'a*b', '', 'foo', '?*'])('does not treat "%s" as catch-all', (p) => {
    expect(matchesEverything(p)).toBe(false);
  });
});

describe('normalizeBulkDeleteParams', () => {
  it('rejects an empty / whitespace-only pattern', () => {
    expect(() => normalizeBulkDeleteParams({ match: '' }, 'execute')).toThrow(
      BulkDeleteValidationError,
    );
    expect(() => normalizeBulkDeleteParams({ match: '   ' }, 'execute')).toThrow(
      BulkDeleteValidationError,
    );
  });

  it('rejects a catch-all pattern unless confirmDeleteAll is set', () => {
    expect(() => normalizeBulkDeleteParams({ match: '*' }, 'execute')).toThrow(
      BulkDeleteValidationError,
    );
    const ok = normalizeBulkDeleteParams({ match: '*', confirmDeleteAll: true }, 'execute');
    expect(ok.match).toBe('*');
  });

  it('allows a scoped wildcard without confirmation', () => {
    expect(normalizeBulkDeleteParams({ match: 'user:*' }, 'execute').match).toBe('user:*');
  });

  it('clamps count into [1, MAX_COUNT] and defaults when absent', () => {
    expect(normalizeBulkDeleteParams({ match: 'a', count: 0 }, 'execute').count).toBe(1);
    expect(normalizeBulkDeleteParams({ match: 'a', count: 999_999 }, 'execute').count).toBe(
      MAX_COUNT,
    );
    expect(normalizeBulkDeleteParams({ match: 'a' }, 'execute').count).toBe(DEFAULT_COUNT);
  });

  it('clamps batchPauseMs to the max', () => {
    expect(
      normalizeBulkDeleteParams({ match: 'a', batchPauseMs: 10_000_000 }, 'execute').batchPauseMs,
    ).toBe(MAX_BATCH_PAUSE_MS);
  });

  it('bounds a dry-run by the preview cap but leaves execute unbounded by default', () => {
    expect(normalizeBulkDeleteParams({ match: 'a' }, 'dry-run').maxKeys).toBe(
      DEFAULT_PREVIEW_MAX_KEYS,
    );
    expect(normalizeBulkDeleteParams({ match: 'a' }, 'execute').maxKeys).toBe(Infinity);
  });

  it('honours an explicit maxKeys', () => {
    expect(normalizeBulkDeleteParams({ match: 'a', maxKeys: 42 }, 'execute').maxKeys).toBe(42);
  });
});

describe('runBulkDelete', () => {
  it('dry-run counts matches, collects a sample, and never unlinks', async () => {
    const { target, unlink } = makeTarget('primary', [
      ['5', ['a', 'b']],
      ['0', ['c']],
    ]);

    const result = await runBulkDelete([target], params({ mode: 'dry-run' }));

    expect(unlink).not.toHaveBeenCalled();
    expect(result.matched).toBe(3);
    expect(result.deleted).toBe(0);
    expect(result.batches).toBe(2);
    expect(result.sampleKeys).toEqual(['a', 'b', 'c']);
    expect(result.nodesDone).toBe(1);
    expect(result.perNode[0]).toMatchObject({ node: 'primary', matched: 3, cursorDone: true });
  });

  it('execute unlinks each batch and totals the deletions', async () => {
    const { target, unlink } = makeTarget('primary', [
      ['7', ['a', 'b']],
      ['0', ['c']],
    ]);

    const result = await runBulkDelete([target], params());

    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenNthCalledWith(1, ['a', 'b']);
    expect(unlink).toHaveBeenNthCalledWith(2, ['c']);
    expect(result.deleted).toBe(3);
    expect(result.matched).toBe(3);
  });

  it('stops at maxKeys and marks the result truncated (never over-deletes)', async () => {
    const { target, unlink, scan } = makeTarget('primary', [['9', ['a', 'b', 'c', 'd']]]);

    const result = await runBulkDelete([target], params({ maxKeys: 2 }));

    expect(result.matched).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.truncated).toBe(true);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(['a', 'b']);
    // Should not keep scanning once the cap is hit.
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly when cancellation is signalled between batches', async () => {
    const { target, unlink } = makeTarget('primary', [
      ['5', ['a']],
      ['6', ['b']],
      ['0', ['c']],
    ]);
    let calls = 0;
    const isCancelled = () => {
      calls += 1;
      return calls > 1; // allow the first batch, cancel before the second
    };

    const result = await runBulkDelete([target], params(), { isCancelled });

    expect(result.cancelled).toBe(true);
    expect(result.deleted).toBe(1);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('fans out across every cluster target', async () => {
    const a = makeTarget('node-a', [['0', ['a1', 'a2']]]);
    const b = makeTarget('node-b', [['0', ['b1']]]);

    const result = await runBulkDelete([a.target, b.target], params());

    expect(result.matched).toBe(3);
    expect(result.deleted).toBe(3);
    expect(result.nodesDone).toBe(2);
    expect(result.perNode.map((n) => n.node)).toEqual(['node-a', 'node-b']);
    expect(a.unlink).toHaveBeenCalledWith(['a1', 'a2']);
    expect(b.unlink).toHaveBeenCalledWith(['b1']);
  });

  it('paces between batches but not after the final one', async () => {
    const { target } = makeTarget('primary', [
      ['5', ['a']],
      ['0', ['b']],
    ]);
    const sleep = jest.fn(async () => {});

    await runBulkDelete([target], params({ batchPauseMs: 100 }), { sleep });

    // One pause after the first (cursor '5') batch, none after the final (cursor '0') batch.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('does not pause when batchPauseMs is 0', async () => {
    const { target } = makeTarget('primary', [
      ['5', ['a']],
      ['0', ['b']],
    ]);
    const sleep = jest.fn(async () => {});

    await runBulkDelete([target], params({ batchPauseMs: 0 }), { sleep });

    expect(sleep).not.toHaveBeenCalled();
  });
});
