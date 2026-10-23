import { describe, expect, it } from 'vitest';
import type { SessionNamespace } from '@betterdb/shared';
import { upsertNamespace } from '../useSessionExplorer';

const ns = (id: string, name = id) => ({ id, name }) as SessionNamespace;

describe('upsertNamespace', () => {
  it('appends a namespace the cached list does not have yet', () => {
    expect(upsertNamespace([ns('a')], ns('b')).map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('replaces an edited namespace in place', () => {
    const result = upsertNamespace([ns('a'), ns('b'), ns('c')], ns('b', 'renamed'));
    expect(result.map((n) => n.name)).toEqual(['a', 'renamed', 'c']);
  });

  it('starts a list when nothing is cached', () => {
    expect(upsertNamespace(undefined, ns('a'))).toEqual([ns('a')]);
  });
});
