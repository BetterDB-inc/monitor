import { WebhookEventType, WebhookPayloadFormat, type WebhookPayload } from '@betterdb/shared';
import { formatWebhookBody } from '@app/webhooks/webhook-payload-formatter';
import {
  HOT_KEY_NAMES_PER_SLOT,
  HOT_KEY_NAME_LIMIT,
  HOT_KEY_TOP,
  type HotKeyReader,
  type HotShardKeyDetail,
  describeHotKeys,
  displayKeyName,
  hotKeysAfterRead,
  hotKeysUnavailable,
  sampleHotKeys,
} from '../hot-shard-keys';

type Freq = number | null | Error;

interface FakeNode extends HotKeyReader {
  sent: Array<Array<string | number | Buffer>>;
}

function node(
  slots: Record<number, Array<[string | Buffer, Freq]>>,
  failKeysInSlot?: Error,
): FakeNode {
  const freqs = new Map<string, Freq>();
  for (const keys of Object.values(slots)) {
    for (const [name, freq] of keys) freqs.set(Buffer.from(name).toString('hex'), freq);
  }
  const sent: FakeNode['sent'] = [];
  const freqOf = (key: Buffer): [Error | null, unknown] => {
    const freq = freqs.get(key.toString('hex'));
    return freq instanceof Error ? [freq, null] : [null, freq ?? null];
  };
  return {
    sent,
    async callBuffer(...args: Array<string | number | Buffer>) {
      sent.push(args);
      if (failKeysInSlot) throw failKeysInSlot;
      const [, , slot, count] = args as [string, string, number, number];
      return (slots[slot] ?? []).slice(0, count).map(([name]) => Buffer.from(name));
    },
    pipeline() {
      const queued: Buffer[] = [];
      return {
        call(...args: Array<string | number | Buffer>) {
          sent.push(args);
          queued.push(args[2] as Buffer);
          return this;
        },
        async exec() {
          return queued.map(freqOf);
        },
      };
    },
  };
}

const objectFreqCalls = (client: FakeNode) => client.sent.filter((args) => args[0] === 'OBJECT');
const keysInSlotCalls = (client: FakeNode) => client.sent.filter((args) => args[0] === 'CLUSTER');
const NO_LFU = new Error(
  'ERR An LFU maxmemory policy is not selected, access frequency not tracked. ' +
    'Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.',
);

describe('sampleHotKeys', () => {
  it('ranks the keys of the given slots by their LFU counter', async () => {
    const client = node({
      12: [
        ['user:1', 40],
        ['user:42', 255],
      ],
      99: [['cart:{9}', 201]],
      500: [['other', 250]],
    });

    await expect(sampleHotKeys(client, [12, 99])).resolves.toEqual({
      keySource: 'lfu',
      keysSampled: 3,
      topKeys: [
        { key: 'user:42', slot: 12, freq: 255 },
        { key: 'cart:{9}', slot: 99, freq: 201 },
        { key: 'user:1', slot: 12, freq: 40 },
      ],
    });
    expect(keysInSlotCalls(client)).toEqual([
      ['CLUSTER', 'GETKEYSINSLOT', 12, HOT_KEY_NAMES_PER_SLOT],
      ['CLUSTER', 'GETKEYSINSLOT', 99, HOT_KEY_NAMES_PER_SLOT],
    ]);
  });

  it('keeps the ten hottest and breaks ties by slot order, then by name', async () => {
    const many: Array<[string, Freq]> = Array.from({ length: 30 }, (_, i) => [
      `k${String(i).padStart(2, '0')}`,
      i < 4 ? 255 : 100 - i,
    ]);
    const client = node({ 7: [['z', 255], ...many.slice(15)], 3: many.slice(0, 15) });

    const read = await sampleHotKeys(client, [7, 3]);

    expect(read.keysSampled).toBe(31);
    expect(read.topKeys).toHaveLength(HOT_KEY_TOP);
    expect(read.topKeys.slice(0, 6).map((k) => k.key)).toEqual([
      'z',
      'k00',
      'k01',
      'k02',
      'k03',
      'k04',
    ]);
  });

  it('sends the bytes it was given back to OBJECT FREQ, so a name that is not UTF-8 is not missed', async () => {
    const binary = Buffer.from([0x75, 0xff, 0xfe, 0x00]);
    const client = node({ 5: [[binary, 77]] });

    const read = await sampleHotKeys(client, [5]);

    expect(read.topKeys).toEqual([{ key: binary.toString('utf8'), slot: 5, freq: 77 }]);
    const [probe] = objectFreqCalls(client);
    expect(probe.slice(0, 2)).toEqual(['OBJECT', 'FREQ']);
    expect(Buffer.isBuffer(probe[2]) && (probe[2] as Buffer).equals(binary)).toBe(true);
  });

  it('skips a key that is gone or has moved and keeps the rest', async () => {
    const client = node({
      5: [
        ['first', 9],
        ['gone', null],
        ['moved', new Error('MOVED 5 10.0.0.2:6379')],
        ['asking', new Error('ASK 5 10.0.0.2:6379')],
        ['last', 3],
      ],
    });

    await expect(sampleHotKeys(client, [5])).resolves.toEqual({
      keySource: 'lfu',
      keysSampled: 2,
      topKeys: [
        { key: 'first', slot: 5, freq: 9 },
        { key: 'last', slot: 5, freq: 3 },
      ],
    });
  });

  it('stops at the first refusal when the node has no LFU policy', async () => {
    const client = node({
      5: [
        ['a', NO_LFU],
        ['b', NO_LFU],
        ['c', NO_LFU],
      ],
      6: [['d', NO_LFU]],
    });

    const read = await sampleHotKeys(client, [5, 6]);

    expect(read).toEqual({
      keySource: 'unavailable',
      keyNote: 'maxmemory-policy is not an LFU policy, so the node keeps no access frequency',
      keysSampled: 0,
      topKeys: [],
    });
    expect(objectFreqCalls(client)).toHaveLength(1);
    expect(keysInSlotCalls(client)).toHaveLength(1);
  });

  it('still notices a missing LFU policy when the first key is gone', async () => {
    const client = node({
      5: [
        ['gone', null],
        ['b', NO_LFU],
        ['c', NO_LFU],
      ],
      6: [['d', 4]],
    });

    const read = await sampleHotKeys(client, [5, 6]);

    expect(read.keySource).toBe('unavailable');
    expect(read.topKeys).toEqual([]);
    expect(keysInSlotCalls(client)).toHaveLength(1);
  });

  it('reports a user that may not list the keys of a slot', async () => {
    const client = node(
      { 5: [['a', 1]] },
      new Error(
        "NOPERM User monitor has no permissions to run the 'cluster|getkeysinslot' command",
      ),
    );

    await expect(sampleHotKeys(client, [5, 6])).resolves.toEqual({
      keySource: 'unavailable',
      keyNote: 'the monitoring user may not run CLUSTER GETKEYSINSLOT',
      keysSampled: 0,
      topKeys: [],
    });
    expect(client.sent).toHaveLength(1);
  });

  it('reports a user that may not read the access frequency', async () => {
    const denied = new Error(
      "NOPERM User monitor has no permissions to run the 'object|freq' command",
    );
    const client = node({
      5: [
        ['a', denied],
        ['b', denied],
      ],
    });

    await expect(sampleHotKeys(client, [5])).resolves.toMatchObject({
      keySource: 'unavailable',
      keyNote: 'the monitoring user may not run OBJECT FREQ on these keys',
      topKeys: [],
    });
    expect(objectFreqCalls(client)).toHaveLength(1);
  });

  it('reports a server that does not know the command', async () => {
    const client = node({}, new Error("ERR unknown subcommand 'GETKEYSINSLOT'. Try CLUSTER HELP."));

    await expect(sampleHotKeys(client, [5])).resolves.toMatchObject({
      keySource: 'unavailable',
      keyNote: 'the server does not support CLUSTER GETKEYSINSLOT',
    });
  });

  it.each([
    'CLUSTERDOWN Hash slot not served',
    'LOADING Valkey is loading the dataset in memory',
    'NOAUTH Authentication required.',
  ])('fails on an OBJECT FREQ error it does not expect: %s', async (message) => {
    const failure = new Error(message);
    const client = node({
      5: [
        ['a', failure],
        ['b', failure],
      ],
      6: [['c', 4]],
    });

    await expect(sampleHotKeys(client, [5, 6])).rejects.toBe(failure);
    expect(objectFreqCalls(client)).toHaveLength(1);
    expect(keysInSlotCalls(client)).toHaveLength(1);
  });

  it('fails on an unexpected error that follows keys it could read', async () => {
    const failure = new Error('CLUSTERDOWN Hash slot not served');
    const client = node({
      5: [
        ['a', 3],
        ['b', 2],
        ['c', failure],
      ],
    });

    await expect(sampleHotKeys(client, [5])).rejects.toBe(failure);
  });

  it('finds no keys in empty slots without calling that a failure', async () => {
    await expect(sampleHotKeys(node({}), [5, 6])).resolves.toEqual({
      keySource: 'lfu',
      keysSampled: 0,
      topKeys: [],
    });
  });
});

describe('hotKeysAfterRead', () => {
  const earlier: HotShardKeyDetail = {
    keySource: 'lfu',
    keysSampled: 2,
    keysSampledAt: 1_000,
    topKeys: [
      { key: 'user:42', slot: 5, freq: 255 },
      { key: 'user:1', slot: 5, freq: 40 },
    ],
  };

  it('takes a read with names and stamps it with its time', () => {
    const read = {
      keySource: 'lfu' as const,
      keysSampled: 1,
      topKeys: [{ key: 'a', slot: 6, freq: 9 }],
    };

    expect(hotKeysAfterRead(earlier, read, 2_000)).toEqual({ ...read, keysSampledAt: 2_000 });
  });

  it('keeps the earlier names when the read failed, and says why', () => {
    const failed = hotKeysUnavailable('reading the keys from the hot primary timed out');

    expect(hotKeysAfterRead(earlier, failed, 2_000)).toEqual({
      ...earlier,
      keyNote:
        'the last read gave no names (reading the keys from the hot primary timed out); ' +
        'these are from an earlier read',
    });
  });

  it('keeps the earlier names when the read skipped every name', () => {
    const skipped = { keySource: 'lfu' as const, keysSampled: 0, topKeys: [] };

    expect(hotKeysAfterRead(earlier, skipped, 2_000)).toEqual({
      ...earlier,
      keyNote: 'the last read gave no names; these are from an earlier read',
    });
  });

  it('keeps the names of the last good read through several bad ones', () => {
    const once = hotKeysAfterRead(earlier, hotKeysUnavailable('first reason'), 2_000);
    const twice = hotKeysAfterRead(once, hotKeysUnavailable('second reason'), 3_000);

    expect(twice).toEqual({
      ...earlier,
      keyNote: 'the last read gave no names (second reason); these are from an earlier read',
    });
  });

  it('drops the note once a read gives names again', () => {
    const kept = hotKeysAfterRead(earlier, hotKeysUnavailable('a reason'), 2_000);
    const read = {
      keySource: 'lfu' as const,
      keysSampled: 1,
      topKeys: [{ key: 'a', slot: 6, freq: 9 }],
    };

    expect(hotKeysAfterRead(kept, read, 3_000)).not.toHaveProperty('keyNote');
  });

  it('gives the failed read itself when there are no earlier names', () => {
    const failed = hotKeysUnavailable('a reason');

    expect(hotKeysAfterRead(undefined, failed, 2_000)).toEqual({ ...failed, keysSampledAt: 2_000 });
    expect(hotKeysAfterRead({ ...failed, keysSampledAt: 1_000 }, failed, 2_000)).toEqual({
      ...failed,
      keysSampledAt: 2_000,
    });
  });
});

describe('displayKeyName', () => {
  it('leaves an ordinary name as it is', () => {
    expect(displayKeyName('user:42:{profile}')).toBe('user:42:{profile}');
  });

  it('cuts a long name at 64 code points', () => {
    const shown = displayKeyName('k'.repeat(200));

    expect(shown).toBe(`${'k'.repeat(HOT_KEY_NAME_LIMIT)}…`);
    expect(displayKeyName('k'.repeat(HOT_KEY_NAME_LIMIT))).toBe('k'.repeat(HOT_KEY_NAME_LIMIT));
  });

  it('never cuts in the middle of a surrogate pair', () => {
    const shown = displayKeyName(`${'k'.repeat(HOT_KEY_NAME_LIMIT - 1)}😀tail`);

    expect(shown).toBe(`${'k'.repeat(HOT_KEY_NAME_LIMIT - 1)}😀…`);
    expect(displayKeyName('😀'.repeat(100))).toBe(`${'😀'.repeat(HOT_KEY_NAME_LIMIT)}…`);
  });

  it('writes control characters as text, so a name cannot add a line or hide text', () => {
    expect(displayKeyName('a\nb\r\tc\u0000d\u001be\u007ff\u0085g')).toBe(
      'a\\x0ab\\x0d\\x09c\\x00d\\x1be\\x7ff\\x85g',
    );
    expect(displayKeyName('a b c‮d​e﻿f')).toBe(
      'a\\u{2028}b\\u{2029}c\\u{202e}d\\u{200b}e\\u{feff}f',
    );
    expect(displayKeyName('a\ud800b')).toBe('a\\u{d800}b');
  });

  it('escapes quotes and backslashes, so the quoted name cannot be closed early', () => {
    expect(displayKeyName('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

describe('describeHotKeys', () => {
  it('lists at most three names with their counter', () => {
    expect(
      describeHotKeys([
        { key: 'user:42', slot: 1, freq: 255 },
        { key: 'cart:{9}', slot: 1, freq: 201 },
        { key: `session:${'a'.repeat(100)}`, slot: 2, freq: 180 },
        { key: 'fourth', slot: 2, freq: 10 },
      ]),
    ).toBe(
      ` Hot keys: "user:42" (freq 255), "cart:{9}" (freq 201), "session:${'a'.repeat(56)}…" (freq 180).`,
    );
  });

  it('says nothing without keys', () => {
    expect(describeHotKeys([])).toBe('');
  });

  describe('through the webhook formats', () => {
    const hostile = '<!channel> `x` [a](http://evil.example) *b*\n"q" <@U123> &amp;';
    const message = `Hot shard a0000000 at 10.0.0.1:6379: CPU 9.0x the cluster median for 60s.${describeHotKeys(
      [{ key: hostile, slot: 1, freq: 255 }],
    )}`;
    const payload: WebhookPayload = {
      event: WebhookEventType.ANOMALY_DETECTED,
      timestamp: 1_700_000_000_000,
      instance: { host: '10.0.0.1', port: 6379 },
      data: { message, metricType: 'hot_shard' },
    };
    const body = (payloadFormat: WebhookPayloadFormat) =>
      formatWebhookBody({ payloadFormat }, payload);

    it('keeps the message on one line', () => {
      expect(message).not.toMatch(/[\r\n]/);
      expect(message).toContain('\\x0a');
    });

    it('is valid JSON that gives the same message back in the generic format', () => {
      expect(JSON.parse(body(WebhookPayloadFormat.GENERIC)).data.message).toBe(message);
    });

    it('cannot mention or link in Slack', () => {
      const slack = body(WebhookPayloadFormat.SLACK);

      expect(() => JSON.parse(slack)).not.toThrow();
      expect(slack).not.toContain('<!channel>');
      expect(slack).not.toContain('<@U123>');
      expect(slack).toContain('&lt;!channel&gt;');
      expect(slack).toContain('&amp;amp;');
    });

    it('cannot format or link in Discord', () => {
      const discord = JSON.parse(body(WebhookPayloadFormat.DISCORD));
      const description: string = discord.embeds[0].description;

      expect(discord.allowed_mentions).toEqual({ parse: [] });
      expect(description).toContain('\\`x\\`');
      expect(description).toContain('\\[a\\]\\(http://evil.example\\)');
      expect(description).toContain('\\*b\\*');
      expect(description).not.toMatch(/[\r\n]/);
    });
  });
});
