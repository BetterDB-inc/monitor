import { memoryForgetTargetDiscriminator } from '@betterdb/shared';

// Lives here rather than in packages/shared because shared has no test script
// and is not in apps/api's jest roots, so a spec there would never run (#407).

describe('memoryForgetTargetDiscriminator', () => {
  it('keys an id target by its memory id', () => {
    expect(memoryForgetTargetDiscriminator({ target_kind: 'id', memory_id: 'mem-1' })).toBe(
      'id:mem-1',
    );
  });

  it('separates two different id targets', () => {
    expect(memoryForgetTargetDiscriminator({ target_kind: 'id', memory_id: 'a' })).not.toBe(
      memoryForgetTargetDiscriminator({ target_kind: 'id', memory_id: 'b' }),
    );
  });

  it('is stable regardless of the order scope keys were assigned', () => {
    // JSON.stringify follows insertion order, so the previous implementation
    // gave these two different keys for the same target. Harmless while the
    // comparison was in memory; permanent once it backs a unique index.
    const a = memoryForgetTargetDiscriminator({
      target_kind: 'scope',
      scope: { threadId: 't1', agentId: 'a1' },
    });
    const b = memoryForgetTargetDiscriminator({
      target_kind: 'scope',
      scope: { agentId: 'a1', threadId: 't1' },
    });

    expect(a).toBe(b);
  });

  it('is stable regardless of tag order', () => {
    const a = memoryForgetTargetDiscriminator({ target_kind: 'scope', tags: ['x', 'y'] });
    const b = memoryForgetTargetDiscriminator({ target_kind: 'scope', tags: ['y', 'x'] });

    expect(a).toBe(b);
  });

  it('treats an absent scope field and an empty one as the same target', () => {
    const absent = memoryForgetTargetDiscriminator({
      target_kind: 'scope',
      scope: { agentId: 'a1' },
    });
    const empty = memoryForgetTargetDiscriminator({
      target_kind: 'scope',
      scope: { agentId: 'a1', threadId: '' },
    });

    expect(absent).toBe(empty);
  });

  it('separates targets that differ only by scope', () => {
    expect(
      memoryForgetTargetDiscriminator({ target_kind: 'scope', scope: { threadId: 't1' } }),
    ).not.toBe(
      memoryForgetTargetDiscriminator({ target_kind: 'scope', scope: { threadId: 't2' } }),
    );
  });

  it('separates targets that differ only by tags', () => {
    expect(memoryForgetTargetDiscriminator({ target_kind: 'scope', tags: ['x'] })).not.toBe(
      memoryForgetTargetDiscriminator({ target_kind: 'scope', tags: ['x', 'y'] }),
    );
  });

  it('does not collide a scope value with a field boundary', () => {
    // A naive join lets a value containing the separator forge another field.
    expect(
      memoryForgetTargetDiscriminator({ target_kind: 'scope', scope: { agentId: 'a&threadId=t' } }),
    ).not.toBe(
      memoryForgetTargetDiscriminator({
        target_kind: 'scope',
        scope: { agentId: 'a', threadId: 't' },
      }),
    );
  });

  it('does not collide a tag containing the tag separator', () => {
    // ['a','b'] and ['a,b'] joined to the same key before values were encoded,
    // so one target silently blocked the other.
    expect(memoryForgetTargetDiscriminator({ target_kind: 'scope', tags: ['a', 'b'] })).not.toBe(
      memoryForgetTargetDiscriminator({ target_kind: 'scope', tags: ['a,b'] }),
    );
  });

  it('does not collide a tag containing the section separator', () => {
    expect(memoryForgetTargetDiscriminator({ target_kind: 'scope', tags: ['a|tags:b'] })).not.toBe(
      memoryForgetTargetDiscriminator({ target_kind: 'scope', tags: ['a'], scope: {} }),
    );
  });

  it('does not collide an id containing a separator', () => {
    expect(memoryForgetTargetDiscriminator({ target_kind: 'id', memory_id: 'a|b' })).not.toBe(
      memoryForgetTargetDiscriminator({ target_kind: 'id', memory_id: 'a%7Cb' }),
    );
  });

  it('never collides an id target with a scope target', () => {
    expect(memoryForgetTargetDiscriminator({ target_kind: 'id', memory_id: 'x' })).not.toBe(
      memoryForgetTargetDiscriminator({ target_kind: 'scope', tags: ['x'] }),
    );
  });
});
