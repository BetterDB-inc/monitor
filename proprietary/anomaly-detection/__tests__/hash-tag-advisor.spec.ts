import {
  type HashTagAdvice,
  describeHashTags,
  hashTagAdvice,
  hashTagsAfterRead,
  hashTagsOfNames,
  hashTagsUnavailable,
  judgeSlotTag,
} from '../hash-tag-advisor';
import { type HotKeyReader, readSlotNames } from '../hot-shard-keys';

interface FakeNode extends Pick<HotKeyReader, 'callBuffer'> {
  sent: Array<Array<string | number | Buffer>>;
}

function node(slots: Record<number, Array<string | Buffer>>): FakeNode {
  const sent: FakeNode['sent'] = [];
  return {
    sent,
    async callBuffer(...args: Array<string | number | Buffer>) {
      sent.push(args);
      const [, , slot, count] = args as [string, string, number, number];
      return (slots[slot] ?? []).slice(0, count).map((name) => Buffer.from(name));
    },
  };
}

const names = (count: number, make: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => make(index));

const names10 = (prefix: string) =>
  names(10, (i) => `${prefix}:${i}`).map((name) => Buffer.from(name));

function advice(overrides: Partial<HashTagAdvice> = {}): HashTagAdvice {
  return {
    tags: [],
    slotsSampled: 1,
    keyCountOutliers: [],
    keyCountOutlierFactor: 20,
    medianKeyCount: 30,
    ...overrides,
  };
}

const tagOf = (name: string | Buffer) => judgeSlotTag(0, [name, name])?.tag ?? null;

const outliersOf = (slots: Array<{ slot: number; keyCount: number }>, median: number | null) =>
  hashTagAdvice(hashTagsUnavailable('none'), slots, median).keyCountOutliers;

describe('the hash tag of a name', () => {
  it('takes the text between the first { and the first } after it', () => {
    expect(tagOf('cart:{42}:items')).toBe('42');
    expect(tagOf('{user:1}{other}')).toBe('user:1');
    expect(tagOf('a{b{c}d}')).toBe('b{c');
  });

  it('finds no tag when the braces are empty, unclosed or absent', () => {
    expect(tagOf('{}cart')).toBeNull();
    expect(tagOf('{}{cart}')).toBeNull();
    expect(tagOf('cart:{42')).toBeNull();
    expect(tagOf('cart}{')).toBeNull();
    expect(tagOf('plain')).toBeNull();
  });

  it('reads the tag from the raw bytes of a binary name', () => {
    expect(tagOf(Buffer.from([0xff, 0x7b, 0x61, 0x7d]))).toBe('a');
  });
});

describe('judgeSlotTag', () => {
  it('names a tag shared by at least half of the sampled names', () => {
    const sampled = [...names(46, (i) => `{cart}:${i}`), ...names(4, (i) => `user:${i}`)];

    expect(judgeSlotTag(9189, sampled)).toEqual({
      slot: 9189,
      tag: 'cart',
      share: 0.92,
      keysSampled: 50,
      keysWithTag: 46,
    });
  });

  it('names a tag at exactly half', () => {
    const sampled = [...names(5, (i) => `{cart}:${i}`), ...names(5, (i) => `user:${i}`)];

    expect(judgeSlotTag(1, sampled)?.tag).toBe('cart');
  });

  it('names nothing when no tag reaches half', () => {
    const sampled = [
      ...names(4, (i) => `{cart}:${i}`),
      ...names(3, (i) => `{user}:${i}`),
      ...names(3, (i) => `plain:${i}`),
    ];

    expect(judgeSlotTag(1, sampled)).toBeNull();
    expect(judgeSlotTag(1, [])).toBeNull();
  });

  it('names nothing when a single key carries the tag', () => {
    expect(judgeSlotTag(1, ['cart:{9}'])).toBeNull();
    expect(judgeSlotTag(1, ['{9}:a', 'b'])).toBeNull();
    expect(judgeSlotTag(1, ['{9}:a', '{9}:b'])?.tag).toBe('9');
  });

  it('keeps binary tags apart that decode to the same text', () => {
    const tagged = (tag: number[], rest: string) =>
      Buffer.concat([Buffer.from([0x7b, ...tag, 0x7d]), Buffer.from(rest)]);

    expect(
      judgeSlotTag(1, [tagged([0x80, 0x80, 0x80], 'a'), tagged([0x81, 0x90, 0xa1], 'b')]),
    ).toBeNull();
    expect(
      judgeSlotTag(1, [tagged([0x80, 0x80, 0x80], 'a'), tagged([0x80, 0x80, 0x80], 'b')]),
    ).toMatchObject({ tag: '\ufffd\ufffd\ufffd', keysWithTag: 2 });
  });

  it('picks the first tag in name order when two tie at half', () => {
    const sampled = [...names(5, (i) => `{b}:${i}`), ...names(5, (i) => `{a}:${i}`)];

    expect(judgeSlotTag(1, sampled)?.tag).toBe('a');
  });
});

describe('hashTagsOfNames', () => {
  it('names the shared tag of each slot in the order read', () => {
    const names = new Map([
      [7, names10('{b}')],
      [3, names10('{a}')],
      [5, names10('plain')],
    ]);

    expect(hashTagsOfNames(names)).toEqual({
      slotsSampled: 3,
      tags: [
        { slot: 7, tag: 'b', share: 1, keysSampled: 10, keysWithTag: 10 },
        { slot: 3, tag: 'a', share: 1, keysSampled: 10, keysWithTag: 10 },
      ],
    });
  });

  it('names the shared tags of the names read from each slot', async () => {
    const client = node({
      9189: [...names(9, (i) => `{cart}:${i}`), 'user:1'],
      9190: names(10, (i) => `user:${i}`),
    });

    const read = await readSlotNames(client, [9189, 9190]);

    expect(hashTagsOfNames(read.names)).toEqual({
      slotsSampled: 2,
      tags: [{ slot: 9189, tag: 'cart', share: 0.9, keysSampled: 10, keysWithTag: 9 }],
    });
  });
});

describe('hashTagAdvice', () => {
  it('names slots holding at least 20 times the median key count, fullest first', () => {
    const slots = [
      { slot: 1, keyCount: 100 },
      { slot: 2, keyCount: 2000 },
      { slot: 3, keyCount: 1999 },
      { slot: 4, keyCount: 4000 },
    ];

    expect(outliersOf(slots, 100)).toEqual([
      { slot: 4, keyCount: 4000, ratio: 40 },
      { slot: 2, keyCount: 2000, ratio: 20 },
    ]);
  });

  it('names no slot under a thousand keys, however small the median', () => {
    const slots = [
      { slot: 1, keyCount: 25 },
      { slot: 2, keyCount: 999 },
      { slot: 3, keyCount: 1000 },
    ];

    expect(outliersOf(slots, 10)).toEqual([{ slot: 3, keyCount: 1000, ratio: 100 }]);
    expect(outliersOf(slots, 0)).toEqual([{ slot: 3, keyCount: 1000, ratio: null }]);
  });

  it('keeps at most ten', () => {
    const slots = Array.from({ length: 12 }, (_, i) => ({ slot: i, keyCount: 1000 + i }));

    expect(outliersOf(slots, 1).map((each) => each.slot)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it('keeps only the tags on slots the shard owns now', () => {
    const cart = { slot: 7, tag: 'cart', share: 1, keysSampled: 2, keysWithTag: 2 };
    const user = { slot: 9, tag: 'user', share: 1, keysSampled: 2, keysWithTag: 2 };
    const read = { tags: [cart, user], slotsSampled: 2 };

    expect(hashTagAdvice(read, [{ slot: 9, keyCount: 10 }], 10).tags).toEqual([user]);
    expect(hashTagAdvice(read, [], 10)).toMatchObject({ tags: [], slotsSampled: 2 });
  });

  it('gives the factor and leaves the median null when it is not known', () => {
    const read = { tags: [], slotsSampled: 2 };

    expect(hashTagAdvice(read, [{ slot: 1, keyCount: 5000 }], null)).toEqual({
      tags: [],
      slotsSampled: 2,
      keyCountOutliers: [],
      keyCountOutlierFactor: 20,
      medianKeyCount: null,
    });
  });
});

describe('hashTagsAfterRead', () => {
  const cart = { slot: 0, tag: 'cart', share: 1, keysSampled: 2, keysWithTag: 2 };
  const last = { read: { tags: [cart], slotsSampled: 2 }, readAt: 100 };

  it('keeps the last tags and their time when the new read sampled no slot', () => {
    expect(hashTagsAfterRead(last, hashTagsUnavailable('ECONNREFUSED'), 200)).toBe(last);
  });

  it('takes a read that sampled slots, even without a tag', () => {
    const read = { tags: [], slotsSampled: 2 };

    expect(hashTagsAfterRead(last, read, 200)).toEqual({ read, readAt: 200 });
  });

  it('takes a failed read when there were no tags to keep', () => {
    const failed = hashTagsUnavailable('ECONNREFUSED');

    expect(hashTagsAfterRead(undefined, failed, 200)).toEqual({ read: failed, readAt: 200 });
    expect(
      hashTagsAfterRead({ read: { tags: [], slotsSampled: 2 }, readAt: 100 }, failed, 200),
    ).toEqual({ read: failed, readAt: 200 });
  });
});

describe('describeHashTags', () => {
  it('names one shared tag and how to split it', () => {
    const text = describeHashTags(
      advice({
        tags: [{ slot: 9189, tag: 'cart', share: 0.92, keysSampled: 500, keysWithTag: 460 }],
      }),
    );

    expect(text).toBe(
      ' 92% of the sampled keys in slot 9189 share the hash tag {cart}. ' +
        'Splitting that tag in the application spreads them across slots.',
    );
  });

  it('names at most three tags', () => {
    const tags = [1, 2, 3, 4].map((slot) => ({
      slot,
      tag: `t${slot}`,
      share: 1,
      keysSampled: 10,
      keysWithTag: 10,
    }));

    const text = describeHashTags(advice({ tags }));

    expect(text).toContain('{t3}');
    expect(text).not.toContain('{t4}');
    expect(text).toContain('Splitting those tags in the application spreads them across slots.');
  });

  it('escapes and cuts a long or unsafe tag', () => {
    const tag = `"${'x'.repeat(80)}`;

    const text = describeHashTags(
      advice({ tags: [{ slot: 1, tag, share: 1, keysSampled: 1, keysWithTag: 1 }] }),
    );

    expect(text).toContain(`{\\"${'x'.repeat(63)}…}`);
  });

  it('names key-count outliers', () => {
    expect(
      describeHashTags(advice({ keyCountOutliers: [{ slot: 4, keyCount: 1200, ratio: 40 }] })),
    ).toBe(' Slot 4 holds 1200 keys, 40x the median slot.');
    expect(
      describeHashTags(
        advice({
          keyCountOutliers: [
            { slot: 4, keyCount: 1200, ratio: 40 },
            { slot: 2, keyCount: 600, ratio: 20 },
            { slot: 5, keyCount: 600, ratio: 20 },
            { slot: 6, keyCount: 600, ratio: 20 },
          ],
        }),
      ),
    ).toBe(
      ' Slots 4 (1200 keys, 40x), 2 (600 keys, 20x) and 5 (600 keys, 20x) ' +
        'each hold at least 20x the median slot.',
    );
  });

  it('says the median slot is empty instead of giving a ratio', () => {
    expect(
      describeHashTags(
        advice({ medianKeyCount: 0, keyCountOutliers: [{ slot: 4, keyCount: 1200, ratio: null }] }),
      ),
    ).toBe(' Slot 4 holds 1200 keys, while the median slot holds none.');
    expect(
      describeHashTags(
        advice({
          medianKeyCount: 0,
          keyCountOutliers: [
            { slot: 4, keyCount: 1200, ratio: null },
            { slot: 2, keyCount: 1100, ratio: null },
          ],
        }),
      ),
    ).toBe(' Slots 4 (1200 keys) and 2 (1100 keys) are crowded, while the median slot holds none.');
  });

  it('gives the factor the advice carries', () => {
    expect(
      describeHashTags(
        advice({
          keyCountOutlierFactor: 25,
          keyCountOutliers: [
            { slot: 4, keyCount: 1200, ratio: 40 },
            { slot: 2, keyCount: 750, ratio: 25 },
          ],
        }),
      ),
    ).toBe(
      ' Slots 4 (1200 keys, 40x) and 2 (750 keys, 25x) each hold at least 25x the median slot.',
    );
  });

  it('says nothing without findings', () => {
    expect(describeHashTags(undefined)).toBe('');
    expect(describeHashTags(advice())).toBe('');
  });
});
