import {
  HASH_TAG_NAMES_PER_SLOT,
  type HashTagAdvice,
  type HashTagReader,
  describeHashTags,
  hashTagOf,
  hashTagsOfNames,
  judgeSlotTag,
  keyCountOutliers,
  sampleHashTags,
} from '../hash-tag-advisor';

interface FakeNode extends HashTagReader {
  sent: Array<Array<string | number | Buffer>>;
}

function node(slots: Record<number, Array<string | Buffer>>, fail?: Error): FakeNode {
  const sent: FakeNode['sent'] = [];
  return {
    sent,
    async callBuffer(...args: Array<string | number | Buffer>) {
      sent.push(args);
      if (fail) throw fail;
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
  return { tags: [], slotsSampled: 1, keyCountOutliers: [], medianKeyCount: 30, ...overrides };
}

describe('hashTagOf', () => {
  it('takes the text between the first { and the first } after it', () => {
    expect(hashTagOf('cart:{42}:items')).toBe('42');
    expect(hashTagOf('{user:1}{other}')).toBe('user:1');
    expect(hashTagOf('a{b{c}d}')).toBe('b{c');
  });

  it('finds no tag when the braces are empty, unclosed or absent', () => {
    expect(hashTagOf('{}cart')).toBeNull();
    expect(hashTagOf('{}{cart}')).toBeNull();
    expect(hashTagOf('cart:{42')).toBeNull();
    expect(hashTagOf('cart}{')).toBeNull();
    expect(hashTagOf('plain')).toBeNull();
  });

  it('reads the tag from the raw bytes of a binary name', () => {
    expect(hashTagOf(Buffer.from([0xff, 0x7b, 0x61, 0x7d]))).toBe('a');
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
});

describe('sampleHashTags', () => {
  it('reads up to 500 names from each slot and names their shared tags', async () => {
    const client = node({
      9189: [...names(9, (i) => `{cart}:${i}`), 'user:1'],
      9190: names(10, (i) => `user:${i}`),
    });

    await expect(sampleHashTags(client, [9189, 9190])).resolves.toEqual({
      slotsSampled: 2,
      tags: [{ slot: 9189, tag: 'cart', share: 0.9, keysSampled: 10, keysWithTag: 9 }],
    });
    expect(client.sent).toEqual([
      ['CLUSTER', 'GETKEYSINSLOT', 9189, HASH_TAG_NAMES_PER_SLOT],
      ['CLUSTER', 'GETKEYSINSLOT', 9190, HASH_TAG_NAMES_PER_SLOT],
    ]);
  });

  it('ends the read with a note when the user may not list keys', async () => {
    const client = node(
      {},
      new Error(
        "NOPERM User monitor has no permissions to run the 'cluster|getkeysinslot' command",
      ),
    );

    await expect(sampleHashTags(client, [1, 2])).resolves.toEqual({
      slotsSampled: 0,
      tags: [],
      note: 'the monitoring user may not run CLUSTER GETKEYSINSLOT',
    });
    expect(client.sent).toHaveLength(1);
  });

  it('ends the read with a note when the server lacks the command', async () => {
    const client = node({}, new Error("ERR unknown subcommand 'GETKEYSINSLOT'"));

    await expect(sampleHashTags(client, [1])).resolves.toMatchObject({
      note: 'the server does not support CLUSTER GETKEYSINSLOT',
    });
  });

  it('lets any other failure through', async () => {
    await expect(sampleHashTags(node({}, new Error('Connection is closed.')), [1])).rejects.toThrow(
      'Connection is closed.',
    );
  });
});

describe('keyCountOutliers', () => {
  it('names slots holding at least 20 times the median key count, fullest first', () => {
    const slots = [
      { slot: 1, keyCount: 30 },
      { slot: 2, keyCount: 600 },
      { slot: 3, keyCount: 599 },
      { slot: 4, keyCount: 1200 },
    ];

    expect(keyCountOutliers(slots, 30)).toEqual([
      { slot: 4, keyCount: 1200, ratio: 40 },
      { slot: 2, keyCount: 600, ratio: 20 },
    ]);
  });

  it('counts an empty median as one key', () => {
    expect(keyCountOutliers([{ slot: 7, keyCount: 25 }], 0)).toEqual([
      { slot: 7, keyCount: 25, ratio: 25 },
    ]);
  });

  it('keeps at most ten', () => {
    const slots = Array.from({ length: 12 }, (_, i) => ({ slot: i, keyCount: 1000 + i }));

    expect(keyCountOutliers(slots, 1).map((each) => each.slot)).toEqual([
      11, 10, 9, 8, 7, 6, 5, 4, 3, 2,
    ]);
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

  it('says nothing without findings', () => {
    expect(describeHashTags(undefined)).toBe('');
    expect(describeHashTags(advice())).toBe('');
  });
});
