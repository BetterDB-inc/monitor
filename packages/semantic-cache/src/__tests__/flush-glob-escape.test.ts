import { describe, it, expect, vi } from 'vitest';
import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

/**
 * Minimal Valkey glob matcher (`*`, `?`, `[...]`, and backslash escapes),
 * so the mock SCAN behaves like the server does for MATCH.
 */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      i++;
      re += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') {
      re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        re += `[${pattern.slice(i + 1, end)}]`;
        i = end;
      }
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 's');
}

function makeClient(allKeys: string[]) {
  const scanPatterns: string[] = [];
  const deleted: string[] = [];
  const client = {
    call: vi.fn(async () => 'OK'),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      scanPatterns.push(pattern);
      const re = globToRegExp(pattern);
      return ['0', allKeys.filter((k) => re.test(k))];
    }),
    pipeline: vi.fn(() => {
      const queued: string[] = [];
      const stub = {
        del: vi.fn((key: string) => {
          queued.push(key);
          return stub;
        }),
        exec: vi.fn(async () => {
          deleted.push(...queued);
          return queued.map(() => [null, 1]);
        }),
      };
      return stub;
    }),
    del: vi.fn(async () => 1),
    hdel: vi.fn(async () => 1),
    hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    expire: vi.fn(async () => 1),
    nodes: vi.fn(() => null),
  };
  return { client, scanPatterns, deleted };
}

describe('flush() with glob metacharacters in the cache name', () => {
  const keys = ['app?:entry:1', 'app?:embed:m:1', 'appX:entry:1', 'appX:embed:m:1'];

  it('escapes the name in the SCAN MATCH patterns', async () => {
    const { client, scanPatterns } = makeClient(keys);
    const cache = new SemanticCache({
      name: 'app?',
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.1, 0.2]),
    });

    await cache.flush();

    expect(scanPatterns).toEqual(['app\\?:entry:*', 'app\\?:embed:*']);
  });

  it("deletes only its own keys, not another cache's", async () => {
    const { client, deleted } = makeClient(keys);
    const cache = new SemanticCache({
      name: 'app?',
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.1, 0.2]),
    });

    await cache.flush();

    expect(deleted.sort()).toEqual(['app?:embed:m:1', 'app?:entry:1']);
  });
});
