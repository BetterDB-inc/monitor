import * as fs from 'fs';
import * as path from 'path';
import type { CapturedKey, KeyView, ParsedMessage, PresetId } from '@betterdb/shared';
import { createCustomPreset } from '../presets/custom';
import { getPreset, parseSessionKeys } from '../presets/registry';
import { decodeValue, estimateTokens } from '../presets/text';

interface Expectation {
  messages: number;
  toolCalls: number;
  roles: string[];
  hasTtl: boolean;
  contents?: string[];
}

interface Fixture {
  library: string;
  preset: PresetId;
  keys: CapturedKey[];
  expectations: Record<string, Expectation>;
}

const FIXTURE_DIR = path.join(__dirname, '../../../test/fixtures/session-explorer');

const fixtures: Fixture[] = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')));

const expectationFor = (fixture: Fixture, sessionId: string): Expectation | undefined =>
  fixture.expectations[sessionId] ??
  fixture.expectations[sessionId.slice(sessionId.lastIndexOf(':') + 1)];

const loadSessions = (fixture: Fixture) => {
  const preset = getPreset(fixture.preset);
  const groups = new Map<string, KeyView[]>();
  for (const k of fixture.keys) {
    const id = preset.sessionIdOf(k.key);
    if (id === null) continue;
    const views = groups.get(id) ?? [];
    views.push(preset.parseKey(k));
    groups.set(id, views);
  }
  return { preset, groups };
};

describe('session presets against captured fixtures', () => {
  it('loads all four fixtures', () => {
    expect(fixtures.map((f) => f.preset).sort()).toEqual([
      'agent-cache',
      'langchain-community',
      'langchain-js',
      'llamaindex',
    ]);
  });

  describe.each(fixtures.map((f) => [f.library, f] as const))('%s', (_name, fixture) => {
    const { preset, groups } = loadSessions(fixture);

    it('covers every expected session', () => {
      const covered = [...groups.keys()].map((id) => expectationFor(fixture, id));
      expect(covered.every(Boolean)).toBe(true);
      expect(groups.size).toBe(Object.keys(fixture.expectations).length);
    });

    it.each(Object.keys(fixture.expectations))('parses session %s', (sessionId) => {
      const entry = [...groups.entries()].find(([id]) => expectationFor(fixture, id) === fixture.expectations[sessionId]);
      expect(entry).toBeDefined();
      const views = entry![1];
      const exp = fixture.expectations[sessionId];
      const messages = preset.mergeSession(views);

      expect(views.every((v) => v.parsed)).toBe(true);
      expect(messages).toHaveLength(exp.messages);
      expect(messages.flatMap((m) => m.toolCalls ?? [])).toHaveLength(exp.toolCalls);
      expect([...new Set(messages.map((m) => m.role))].sort()).toEqual([...new Set(exp.roles)].sort());
      expect(views.some((v) => v.ttlMs !== null)).toBe(exp.hasTtl);
      if (exp.contents) {
        expect(messages.map((m) => m.content)).toEqual(exp.contents);
      }
    });
  });

  it('unicode session round-trips content exactly', () => {
    for (const fixture of fixtures) {
      const { preset, groups } = loadSessions(fixture);
      const id = [...groups.keys()].find((k) => k.endsWith('unicode'))!;
      const messages = preset.mergeSession(groups.get(id)!);
      expect(messages.map((m) => m.content)).toEqual(fixture.expectations.unicode.contents);
    }
  });

  it('extracts tool call arguments and tool results', () => {
    for (const fixture of fixtures) {
      const { preset, groups } = loadSessions(fixture);
      const id = [...groups.keys()].find((k) => k.endsWith('tool-call'))!;
      const messages: ParsedMessage[] = preset.mergeSession(groups.get(id)!);
      const call = messages.flatMap((m) => m.toolCalls ?? [])[0];
      const result = messages.find((m) => m.role === 'tool')!.toolResult!;
      expect(call).toEqual({ name: 'get_weather', args: { city: 'Sofia' }, id: 'call_weather_1' });
      expect(result.name).toBe('get_weather');
      expect(result.callId).toBe('call_weather_1');
    }
  });

  it('agent-cache merges the newest checkpoint only', () => {
    const fixture = fixtures.find((f) => f.preset === 'agent-cache')!;
    const { preset, groups } = loadSessions(fixture);
    const views = groups.get('multi-turn')!;
    const checkpoints = views.filter((v) => v.key.includes(':checkpoint:'));
    expect(checkpoints.length).toBeGreaterThan(1);
    expect(preset.mergeSession(views)).toHaveLength(7);
    const withoutLatest = views.filter((v) => !v.key.endsWith('__checkpoint_latest'));
    expect(preset.mergeSession(withoutLatest)).toHaveLength(7);
  });

  it('agent-cache does not fall back to a stale checkpoint when latest is unparsed', () => {
    const fixture = fixtures.find((f) => f.preset === 'agent-cache')!;
    const { preset, groups } = loadSessions(fixture);
    const views = groups.get('multi-turn')!;
    const broken = views.map((v) =>
      v.key.endsWith('__checkpoint_latest')
        ? ({ ...v, parsed: false, reason: 'Value is not valid JSON' } as KeyView)
        : v,
    );
    expect(broken.some((v) => !v.parsed)).toBe(true);
    expect(preset.mergeSession(broken)).toEqual([]);
    const withoutLatest = views.filter((v) => !v.key.endsWith('__checkpoint_latest'));
    expect(preset.mergeSession(withoutLatest)).toHaveLength(7);
  });

  it('agent-cache shows a pending write that no checkpoint holds yet', () => {
    const fixture = fixtures.find((f) => f.preset === 'agent-cache')!;
    const { preset, groups } = loadSessions(fixture);
    const views = groups.get('pending-write')!;
    const latest = views.find((v) => v.key.endsWith('__checkpoint_latest'))!;
    expect(latest.parsed && latest.messages).toHaveLength(2);
    expect(preset.mergeSession(views).map((m) => m.content)).toEqual(
      fixture.expectations['pending-write'].contents,
    );
  });

  it('agent-cache leaves writes folded into a newer checkpoint out of the merge', () => {
    const fixture = fixtures.find((f) => f.preset === 'agent-cache')!;
    const preset = getPreset('agent-cache');
    const session = fixture.keys.filter((k) => k.key.includes(':session:multi-turn:'));
    const writes = session.filter((k) => k.key.includes(':writes:'));
    expect(writes.length).toBeGreaterThan(0);
    for (const k of writes) {
      expect(preset.parseKey(k)).toMatchObject({ parsed: true, messages: [{ role: 'ai' }] });
    }
    expect(preset.selectKeys!(session.map((k) => k.key))).toEqual([
      'sxfix:ac:session:multi-turn:__checkpoint_latest',
    ]);
    expect(preset.mergeSession(session.map((k) => preset.parseKey(k)))).toHaveLength(7);
  });

  it('ignores non-session keys under the prefix', () => {
    const preset = getPreset('agent-cache');
    expect(preset.sessionIdOf('sxfix:ac:__stats')).toBeNull();
    expect(preset.sessionIdOf('sxfix:ac:session:t1:__checkpoint_latest')).toBe('t1');
    expect(preset.sessionIdOf('sxfix:ac:session:t1:checkpoint:abc')).toBe('t1');
    expect(preset.sessionIdOf('sxfix:ac:session:t1:writes:abc%7Ctask%7Cmessages%7C0')).toBe('t1');
    expect(preset.sessionIdOf('sxfix:ac:session:t1:last_intent')).toBe('t1');
    expect(preset.sessionIdOf('app:session:store:session:t1:checkpoint:abc')).toBe(
      'store:session:t1',
    );
    expect(preset.sessionIdOf('sxfix:ac:session::last_intent')).toBeNull();
    expect(preset.sessionIdOf('other:session:t1')).toBeNull();
    expect(preset.defaultPattern('sxfix:ac')).toBe('sxfix:ac:session:*');
  });

  it('agent-cache reads the thread id after the namespace prefix', () => {
    const preset = getPreset('agent-cache', null, 'app:session:*');
    expect(preset.sessionIdOf('app:session:t1:prefs:lang')).toBe('t1');
    expect(preset.sessionIdOf('app:session:t1:last_intent')).toBe('t1');
    expect(preset.sessionIdOf('app:session:run:checkpoint:7:checkpoint:abc')).toBe('run:checkpoint:7');
    expect(preset.sessionIdOf('app:session:run:checkpoint:7:__checkpoint_latest')).toBe(
      'run:checkpoint:7',
    );
    expect(preset.sessionIdOf('app:session:run:checkpoint:7:writes:abc|task|messages|0')).toBe(
      'run:checkpoint:7',
    );
    expect(preset.sessionIdOf('app:session:run:writes:x:checkpoint:abc')).toBe('run:writes:x');
    expect(preset.sessionIdOf('app:session:t1:checkpoint:abc')).toBe('t1');
    expect(preset.sessionIdOf('app:session:store:session:t1:checkpoint:abc')).toBe(
      'store:session:t1',
    );
    expect(preset.sessionIdOf('app:session:store:session:t1:last_intent')).toBe('store');
    expect(preset.sessionIdOf('other:session:t1:checkpoint:abc')).toBeNull();
    expect(preset.sessionIdOf('app:session::last_intent')).toBeNull();
  });

  it('agent-cache takes the namespace prefix from an escaped or narrowed pattern', () => {
    const escaped = getPreset('agent-cache', null, 'tenant\\[1\\]:session:*');
    expect(escaped.sessionIdOf('tenant[1]:session:t1:prefs:lang')).toBe('t1');
    const narrowed = getPreset('agent-cache', null, 'app:session:t*');
    expect(narrowed.sessionIdOf('app:session:t1:prefs:lang')).toBe('t1');
  });

  it('agent-cache tells writes and checkpoints apart by the rightmost marker', () => {
    const preset = getPreset('agent-cache', null, 'app:session:*');
    const p = 'app:session:run:checkpoint:7';
    expect(
      preset.selectKeys!([
        `${p}:checkpoint:a`,
        `${p}:checkpoint:b`,
        `${p}:writes:a|t|messages|0`,
        `${p}:writes:b|t|messages|0`,
      ]),
    ).toEqual([`${p}:checkpoint:b`, `${p}:writes:b|t|messages|0`]);
  });

  it('agent-cache default pattern accepts a trailing colon and escapes the name', () => {
    const preset = getPreset('agent-cache');
    expect(preset.defaultPattern('myapp:')).toBe('myapp:session:*');
    expect(preset.defaultPattern('my*app[1]?\\')).toBe('my\\*app\\[1\\]\\?\\\\:session:*');
  });

  it('agent-cache shows session store fields as parsed state', () => {
    const view = getPreset('agent-cache').parseKey({
      key: 'sxfix:ac:session:t1:last_intent',
      type: 'string',
      pttl: -1,
      value: 'book a flight',
    });
    expect(view).toMatchObject({ parsed: true, messages: [] });
  });

  it('agent-cache shows the newest checkpoint as unreadable instead of an older one', () => {
    const fixture = fixtures.find((f) => f.preset === 'agent-cache')!;
    const keys = fixture.keys.filter(
      (k) => k.key.includes(':session:multi-turn:') && !k.key.endsWith('__checkpoint_latest'),
    );
    const newest = keys
      .filter((k) => k.key.includes(':checkpoint:'))
      .map((k) => k.key)
      .sort()
      .pop();
    const capped = keys.map((k) => (k.key === newest ? { ...k, truncated: true } : k));
    const preset = getPreset('agent-cache');
    expect(preset.mergeSession(capped.map((k) => preset.parseKey(k)))).toEqual([]);
    expect(preset.mergeSession(parseSessionKeys(preset, capped))).toEqual([]);
  });

  it('agent-cache fully parses only the newest checkpoint of a session', () => {
    const fixture = fixtures.find((f) => f.preset === 'agent-cache')!;
    const preset = getPreset('agent-cache');
    const session = fixture.keys.filter((k) => k.key.includes(':session:multi-turn:'));
    const checkpoints = (views: KeyView[]) =>
      views
        .filter((v) => v.key.includes(':checkpoint:') || v.key.endsWith('__checkpoint_latest'))
        .map((v) => (v.parsed ? v.messages.length : -1));

    const withLatest = parseSessionKeys(preset, session);
    expect(checkpoints(withLatest).sort()).toEqual([0, 0, 0, 7]);
    expect(preset.mergeSession(withLatest)).toHaveLength(7);

    const withoutLatest = session.filter((k) => !k.key.endsWith('__checkpoint_latest'));
    const views = parseSessionKeys(preset, withoutLatest);
    expect(checkpoints(views).sort()).toEqual([0, 0, 7]);
    expect(preset.mergeSession(views)).toHaveLength(7);
  });

  it('malformed value falls back to raw with reason', () => {
    for (const fixture of fixtures) {
      const preset = getPreset(fixture.preset);
      const source = fixture.keys.find((k) => k.type !== 'hash')!;
      const asString = preset.parseKey({ ...source, value: '{not json' });
      expect(asString.parsed).toBe(false);
      expect(asString.parsed === false && asString.reason.length).toBeGreaterThan(0);
      expect(asString.raw).toBe('{not json');

      if (Array.isArray(source.value)) {
        const brokenElement = preset.parseKey({ ...source, value: [...(source.value as string[]), '{not json'] });
        expect(brokenElement.parsed).toBe(false);
        const wrongShape = preset.parseKey({ ...source, value: ['{"unexpected":true}'] });
        expect(wrongShape.parsed).toBe(false);
      }
    }
  });

  it('truncated and binary values never parse', () => {
    const fixture = fixtures.find((f) => f.preset === 'llamaindex')!;
    const preset = getPreset('llamaindex');
    const source = fixture.keys[0];
    expect(preset.parseKey({ ...source, truncated: true }).parsed).toBe(false);
    const binary = preset.parseKey({ ...source, type: 'string', value: '//4A', binary: true });
    expect(binary).toMatchObject({
      parsed: false,
      binary: true,
      reason: 'Value is not valid UTF-8',
    });
  });

  it('reads a JSON document with a base64 property as data, not binary', () => {
    const preset = createCustomPreset({
      valueType: 'json',
      messages: { from: 'path', path: 'turns' },
      fields: { role: 'who', content: 'text' },
    });
    const view = preset.parseKey({
      key: 'k',
      type: 'ReJSON-RL',
      pttl: -1,
      value: { base64: 'x', turns: [{ who: 'user', text: 'hi' }] },
    });
    expect(view).toMatchObject({ parsed: true, binary: false, messages: [{ content: 'hi' }] });
  });

  it('exposes ttl as null when the key has no expiry', () => {
    const fixture = fixtures.find((f) => f.preset === 'llamaindex')!;
    const preset = getPreset('llamaindex');
    const noTtl = fixture.keys.find((k) => k.pttl === -1)!;
    const withTtl = fixture.keys.find((k) => k.pttl > 0)!;
    expect(preset.parseKey(noTtl).ttlMs).toBeNull();
    expect(preset.parseKey(withTtl).ttlMs).toBe(withTtl.pttl);
  });

  it('langchain-js is an alias with its own default pattern', () => {
    const js = getPreset('langchain-js');
    const community = getPreset('langchain-community');
    expect(js.id).toBe('langchain-js');
    expect(community.id).toBe('langchain-community');
    expect(js.defaultPattern('app:')).toBe('app:*');
  });

  it.each(['langchain-community', 'langchain-js', 'llamaindex', 'raw'] as const)(
    '%s default pattern escapes the prefix',
    (id) => {
      expect(getPreset(id).defaultPattern('tenant[1]*:')).toBe('tenant\\[1\\]\\*:*');
    },
  );

  it('custom default pattern escapes the prefix', () => {
    const preset = createCustomPreset({
      valueType: 'list',
      messages: { from: 'items' },
      fields: { role: 'role', content: 'content' },
    });
    expect(preset.defaultPattern('tenant[1]?:')).toBe('tenant\\[1\\]\\?:*');
  });

  it('raw preset never parses', () => {
    const preset = getPreset('raw');
    expect(preset.sessionIdOf('a:b')).toBe('a:b');
    const view = preset.parseKey({ key: 'a:b', type: 'string', pttl: -1, value: 'x' });
    expect(view).toMatchObject({ parsed: false, reason: 'No schema configured' });
  });
});

describe('decodeValue', () => {
  it('non-utf8 value falls back to base64 raw', () => {
    expect(decodeValue(Buffer.from([0xff, 0xfe, 0x00]), 1024)).toEqual({
      value: '//4A',
      binary: true,
      truncated: false,
    });
  });

  it('returns utf8 text unchanged', () => {
    expect(decodeValue(Buffer.from('héllo 🚀', 'utf8'), 1024)).toEqual({
      value: 'héllo 🚀',
      binary: false,
      truncated: false,
    });
  });

  it('truncates at cap', () => {
    const cap = 2 * 1024 * 1024;
    const result = decodeValue(Buffer.alloc(3 * 1024 * 1024, 'a'), cap);
    expect(result.truncated).toBe(true);
    expect((result.value as string).length).toBe(cap);
  });

  it('strips a leading UTF-8 BOM so JSON values still parse', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
    expect(decodeValue(buf, 1024)).toEqual({ value: '{"a":1}', binary: false, truncated: false });
  });

  it('does not report a multibyte cut at the cap as binary', () => {
    const result = decodeValue(Buffer.from('aé', 'utf8'), 2);
    expect(result.truncated).toBe(true);
    expect(result.value).toBe('a');
  });
});

describe('presets with content blocks beyond text', () => {
  const listKey = (elements: unknown[]): CapturedKey => ({
    key: 'k',
    type: 'list',
    pttl: -1,
    value: elements.map((e) => JSON.stringify(e)),
  });
  const parsedMessages = (view: KeyView): ParsedMessage[] => {
    expect(view.parsed).toBe(true);
    return view.parsed ? view.messages : [];
  };

  it('langchain keeps text, maps Anthropic tool_use blocks to tool calls and marks other blocks', () => {
    const view = getPreset('langchain-community').parseKey(
      listKey([
        {
          type: 'ai',
          data: {
            content: [
              { type: 'text', text: 'Let me check' },
              { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Sofia' } },
            ],
          },
        },
        {
          type: 'human',
          data: {
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'data:' } },
            ],
          },
        },
      ]),
    );
    const [human, ai] = parsedMessages(view);
    expect(human.content).toBe('What is this?\n[image_url]');
    expect(ai).toEqual({
      role: 'ai',
      content: 'Let me check',
      toolCalls: [{ name: 'get_weather', args: { city: 'Sofia' }, id: 'toolu_1' }],
    });
  });

  it('langchain keeps text blocks apart and hides v1 tool_call blocks', () => {
    const view = getPreset('langchain-community').parseKey(
      listKey([
        {
          type: 'ai',
          data: {
            content: [
              { type: 'text', text: 'First.' },
              { type: 'text', text: 'Second.' },
              { type: 'tool_call', id: 'call_1', name: 'lookup', args: { q: 1 } },
            ],
            tool_calls: [{ name: 'lookup', args: { q: 1 }, id: 'call_1' }],
          },
        },
      ]),
    );
    expect(parsedMessages(view)).toEqual([
      {
        role: 'ai',
        content: 'First.\nSecond.',
        toolCalls: [{ name: 'lookup', args: { q: 1 }, id: 'call_1' }],
      },
    ]);
  });

  it('langchain prefers tool_calls over tool_use blocks when both are present', () => {
    const view = getPreset('langchain-community').parseKey(
      listKey([
        {
          type: 'ai',
          data: {
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'from_block', input: {} }],
            tool_calls: [{ name: 'from_calls', args: {}, id: 'toolu_1' }],
          },
        },
      ]),
    );
    expect(parsedMessages(view)[0].toolCalls).toEqual([
      { name: 'from_calls', args: {}, id: 'toolu_1' },
    ]);
  });

  it('agent-cache reads streamed chunk message classes', () => {
    const lc = (name: string, kwargs: Record<string, unknown>) => ({
      lc: 1,
      type: 'constructor',
      id: ['langchain_core', 'messages', name],
      kwargs,
    });
    const value = JSON.stringify({
      checkpoint: {
        channel_values: {
          messages: [
            lc('HumanMessage', { content: 'hi' }),
            lc('AIMessageChunk', { content: 'hello' }),
          ],
        },
      },
    });
    const view = getPreset('agent-cache').parseKey({
      key: 'p:session:t1:__checkpoint_latest',
      type: 'string',
      pttl: -1,
      value,
    });
    expect(parsedMessages(view).map((m) => m.role)).toEqual(['human', 'ai']);
  });

  it('agent-cache reads chat and function message classes', () => {
    const lc = (name: string, kwargs: Record<string, unknown>) => ({
      lc: 1,
      type: 'constructor',
      id: ['langchain_core', 'messages', name],
      kwargs,
    });
    const value = JSON.stringify({
      checkpoint: {
        channel_values: {
          messages: [
            lc('ChatMessage', { content: 'too long', role: 'critic' }),
            lc('ChatMessageChunk', { content: 'streamed', role: 'narrator' }),
            lc('ChatMessage', { content: 'no role' }),
            lc('FunctionMessage', { content: '{"t":21}', name: 'get_weather' }),
            lc('FunctionMessageChunk', { content: '{"t":22}', name: 'get_weather' }),
          ],
        },
      },
    });
    const view = getPreset('agent-cache').parseKey({
      key: 'p:session:t1:__checkpoint_latest',
      type: 'string',
      pttl: -1,
      value,
    });
    const messages = parsedMessages(view);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['critic', 'too long'],
      ['narrator', 'streamed'],
      ['chat', 'no role'],
      ['tool', '{"t":21}'],
      ['tool', '{"t":22}'],
    ]);
    expect(messages[3].toolResult).toEqual({ name: 'get_weather', content: '{"t":21}' });
  });

  describe('agent-cache pending writes', () => {
    const lc = (name: string, content: string) => ({
      lc: 1,
      type: 'constructor',
      id: ['langchain_core', 'messages', name],
      kwargs: { content },
    });
    const checkpointValue = (id: string, contents: string[]) =>
      JSON.stringify({
        checkpoint: {
          id,
          channel_values: {
            messages: contents.map((c, i) => lc(i % 2 === 0 ? 'HumanMessage' : 'AIMessage', c)),
          },
        },
      });
    const str = (key: string, value: string): CapturedKey => ({ key, type: 'string', pttl: -1, value });
    const p = 'app:session:t1';
    const keys: CapturedKey[] = [
      str(`${p}:checkpoint:1f0-a`, checkpointValue('1f0-a', ['hi'])),
      str(`${p}:checkpoint:1f0-b`, checkpointValue('1f0-b', ['hi', 'hello'])),
      str(`${p}:__checkpoint_latest`, checkpointValue('1f0-b', ['hi', 'hello'])),
      str(`${p}:writes:1f0-a|task-1|messages|0`, JSON.stringify([lc('AIMessage', 'hello')])),
      str(`${p}:writes:1f0-b|task-3|messages|0`, JSON.stringify(lc('AIMessage', 'second'))),
      str(`${p}:writes:1f0-b|task-2|messages|1`, JSON.stringify([lc('AIMessage', 'first b')])),
      str(`${p}:writes:1f0-b|task-2|messages|0`, JSON.stringify([lc('AIMessage', 'first a')])),
      str(`${p}:writes:1f0-b|task-2|__interrupt__|0`, JSON.stringify([{ value: 'ask' }])),
      str(`${p}:last_intent`, 'book a flight'),
    ];
    const preset = getPreset('agent-cache');

    it('selects the newest checkpoint and its writes from key names alone', () => {
      expect(preset.selectKeys!(keys.map((k) => k.key))).toEqual([
        `${p}:__checkpoint_latest`,
        `${p}:writes:1f0-b|task-3|messages|0`,
        `${p}:writes:1f0-b|task-2|messages|1`,
        `${p}:writes:1f0-b|task-2|messages|0`,
        `${p}:writes:1f0-b|task-2|__interrupt__|0`,
        `${p}:last_intent`,
      ]);
      const withoutLatest = keys.map((k) => k.key).filter((k) => !k.endsWith('__checkpoint_latest'));
      expect(preset.selectKeys!(withoutLatest)).toContain(`${p}:checkpoint:1f0-b`);
      expect(preset.selectKeys!(withoutLatest)).not.toContain(`${p}:checkpoint:1f0-a`);
    });

    it('matches writes by URL-decoded checkpoint id', () => {
      const encoded = [`${p}:checkpoint:a|b`, `${p}:writes:a%7Cb|t|messages|0`];
      expect(preset.selectKeys!(encoded)).toEqual(encoded);
    });

    it('reads pending writes in the raw forms add_messages accepts', () => {
      const write = (value: unknown) =>
        parsedMessages(
          preset.parseKey(str(`${p}:writes:1f0-b|task-9|messages|0`, JSON.stringify(value))),
        );
      expect(write([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'human', content: 'hi' }]);
      expect(write({ role: 'developer', content: 'rules' })).toEqual([
        { role: 'system', content: 'rules' },
      ]);
      expect(
        write({ type: 'ai', content: 'ok', tool_calls: [{ name: 'lookup', args: { q: 1 }, id: 'c1' }] }),
      ).toEqual([
        { role: 'ai', content: 'ok', toolCalls: [{ name: 'lookup', args: { q: 1 }, id: 'c1' }] },
      ]);
      expect(write([{ role: 'tool', content: '42', name: 'lookup', tool_call_id: 'c1' }])).toEqual([
        { role: 'tool', content: '42', toolResult: { name: 'lookup', content: '42', callId: 'c1' } },
      ]);
      expect(
        write([
          ['user', 'hi'],
          ['assistant', 'yo'],
        ]),
      ).toEqual([
        { role: 'human', content: 'hi' },
        { role: 'ai', content: 'yo' },
      ]);
      expect(write('hello')).toEqual([{ role: 'human', content: 'hello' }]);
      expect(write(['hello', lc('AIMessage', 'there')])).toEqual([
        { role: 'human', content: 'hello' },
        { role: 'ai', content: 'there' },
      ]);
    });

    it('merges raw-form pending writes into the session', () => {
      const raw = str(
        `${p}:writes:1f0-b|task-4|messages|0`,
        JSON.stringify([{ role: 'user', content: 'interrupted' }]),
      );
      const merged = preset.mergeSession(parseSessionKeys(preset, [...keys, raw]));
      expect(merged.map((m) => m.content)).toEqual([
        'hi',
        'hello',
        'first a',
        'first b',
        'second',
        'interrupted',
      ]);
    });

    it('appends pending message writes of the newest checkpoint in task and index order', () => {
      const merged = preset.mergeSession(parseSessionKeys(preset, keys));
      expect(merged.map((m) => m.content)).toEqual(['hi', 'hello', 'first a', 'first b', 'second']);
      const selected = new Set(preset.selectKeys!(keys.map((k) => k.key)));
      const fetched = keys.filter((k) => selected.has(k.key));
      expect(preset.mergeSession(parseSessionKeys(preset, fetched))).toEqual(merged);
    });
  });

  it('agent-cache counts a checkpoint without a messages channel as empty', () => {
    const preset = getPreset('agent-cache');
    const checkpoint = (channel_values: Record<string, unknown>) => ({
      key: 'p:session:t1:__checkpoint_latest',
      type: 'string',
      pttl: -1,
      value: JSON.stringify({ checkpoint: { channel_values } }),
    });
    for (const channels of [{ __start__: { messages: [] } }, { state: { step: 1 } }]) {
      const view = preset.parseKey(checkpoint(channels));
      expect(view).toMatchObject({ parsed: true, messages: [] });
      expect(preset.mergeSession([view])).toEqual([]);
    }
  });

  it('agent-cache rejects constructor names inherited from Object', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const value = JSON.stringify({
        checkpoint: {
          channel_values: {
            messages: [{ lc: 1, type: 'constructor', id: ['x', name], kwargs: { content: 'hi' } }],
          },
        },
      });
      const view = getPreset('agent-cache').parseKey({
        key: 'p:session:t1:__checkpoint_latest',
        type: 'string',
        pttl: -1,
        value,
      });
      expect(view).toMatchObject({ parsed: false, reason: 'Unknown message constructor' });
    }
  });

  it('langchain reads chunk, chat, function and generic message types', () => {
    const view = getPreset('langchain-community').parseKey(
      listKey([
        { type: 'generic', data: { content: 'js chat', role: 'critic' } },
        { type: 'function', data: { content: '{"t":21}', name: 'get_weather' } },
        { type: 'chat', data: { content: 'py chat', role: 'narrator' } },
        { type: 'AIMessageChunk', data: { content: 'streamed' } },
        { type: 'HumanMessageChunk', data: { content: 'typed' } },
      ]),
    );
    const messages = parsedMessages(view);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['human', 'typed'],
      ['ai', 'streamed'],
      ['narrator', 'py chat'],
      ['tool', '{"t":21}'],
      ['critic', 'js chat'],
    ]);
    expect(messages[3].toolResult).toEqual({ name: 'get_weather', content: '{"t":21}' });
  });

  it('langchain still rejects an unknown message type', () => {
    const view = getPreset('langchain-community').parseKey(
      listKey([{ type: 'constructor', data: { content: 'x' } }]),
    );
    expect(view).toMatchObject({ parsed: false, reason: 'Unknown message type "constructor"' });
  });

  it('llamaindex maps developer, function, chatbot and model roles', () => {
    const block = (text: string) => [{ block_type: 'text', text }];
    const view = getPreset('llamaindex').parseKey(
      listKey([
        { role: 'developer', blocks: block('rules') },
        { role: 'chatbot', blocks: block('hi') },
        { role: 'model', blocks: block('hello') },
        { role: 'function', blocks: block('21C'), additional_kwargs: { name: 'get_weather' } },
      ]),
    );
    expect(parsedMessages(view).map((m) => m.role)).toEqual(['system', 'ai', 'ai', 'tool']);
  });

  it('llamaindex reads messages stored before content blocks', () => {
    const view = getPreset('llamaindex').parseKey(
      listKey([
        { role: 'user', content: 'hi', additional_kwargs: {} },
        { role: 'assistant', content: null, additional_kwargs: {} },
      ]),
    );
    expect(parsedMessages(view).map((m) => [m.role, m.content])).toEqual([
      ['human', 'hi'],
      ['ai', ''],
    ]);
  });

  it('llamaindex rejects roles inherited from Object', () => {
    for (const role of ['constructor', 'toString', '__proto__']) {
      const view = getPreset('llamaindex').parseKey(listKey([{ role, content: 'x' }]));
      expect(view).toMatchObject({ parsed: false, reason: `Unknown role "${role}"` });
    }
  });

  it('llamaindex keeps a malformed tool-call argument string as raw text', () => {
    const view = getPreset('llamaindex').parseKey(
      listKey([
        {
          role: 'assistant',
          blocks: [],
          additional_kwargs: {
            tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{"q": ' } }],
          },
        },
      ]),
    );
    expect(parsedMessages(view)[0].toolCalls).toEqual([{ name: 'lookup', args: '{"q": ', id: 'c1' }]);
  });

  it('llamaindex joins text blocks with newlines and skips blocks with nothing to show', () => {
    const view = getPreset('llamaindex').parseKey(
      listKey([
        {
          role: 'assistant',
          blocks: [
            { block_type: 'text', text: 'First paragraph.' },
            { block_type: 'cache', cache_control: { type: 'ephemeral' } },
            { block_type: 'citation', cited_content: { block_type: 'text', text: 'x' } },
            { block_type: 'text', text: 'Second paragraph.' },
          ],
        },
      ]),
    );
    expect(parsedMessages(view)[0].content).toBe('First paragraph.\nSecond paragraph.');
  });

  it('llamaindex reads tool-call arguments stored as an object', () => {
    const view = getPreset('llamaindex').parseKey(
      listKey([
        {
          role: 'assistant',
          blocks: [],
          additional_kwargs: {
            tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Sofia' } } }],
          },
        },
      ]),
    );
    expect(parsedMessages(view)[0].toolCalls).toEqual([
      { name: 'get_weather', args: { city: 'Sofia' } },
    ]);
  });

  it('llamaindex reads tool_call blocks, Anthropic tool_use dicts and marks other blocks', () => {
    const view = getPreset('llamaindex').parseKey(
      listKey([
        {
          role: 'assistant',
          blocks: [
            { block_type: 'thinking', content: 'hmm' },
            { block_type: 'text', text: 'Checking' },
            { block_type: 'tool_call', tool_call_id: 'c1', tool_name: 'lookup', tool_kwargs: { q: 1 } },
          ],
        },
        {
          role: 'assistant',
          blocks: [{ block_type: 'image', url: 'x' }],
          additional_kwargs: {
            tool_calls: [{ id: 'toolu_1', name: 'get_weather', input: { city: 'Sofia' }, type: 'tool_use' }],
          },
        },
      ]),
    );
    const [first, second] = parsedMessages(view);
    expect(first).toEqual({
      role: 'ai',
      content: '[thinking]\nChecking',
      toolCalls: [{ name: 'lookup', args: { q: 1 }, id: 'c1' }],
    });
    expect(second).toEqual({
      role: 'ai',
      content: '[image]',
      toolCalls: [{ name: 'get_weather', args: { city: 'Sofia' }, id: 'toolu_1' }],
    });
  });
});

describe('estimateTokens', () => {
  it('is ceil of content chars over 4', () => {
    const messages: ParsedMessage[] = [
      { role: 'human', content: '12345' },
      { role: 'ai', content: '67890' },
    ];
    expect(estimateTokens(messages)).toBe(3);
  });
});
