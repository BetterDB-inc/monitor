import * as fs from 'fs';
import * as path from 'path';
import type { CapturedKey, KeyView, ParsedMessage, PresetId } from '@betterdb/shared';
import { getPreset } from '../presets/registry';
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

  it('agent-cache writes keys parse as empty messages', () => {
    const fixture = fixtures.find((f) => f.preset === 'agent-cache')!;
    const preset = getPreset('agent-cache');
    const writes = fixture.keys.filter((k) => k.key.includes(':writes:'));
    expect(writes.length).toBeGreaterThan(0);
    for (const k of writes) {
      const view = preset.parseKey(k);
      expect(view).toMatchObject({ parsed: true, messages: [] });
    }
  });

  it('ignores non-session keys under the prefix', () => {
    const preset = getPreset('agent-cache');
    expect(preset.sessionIdOf('sxfix:ac:__stats')).toBeNull();
    expect(preset.sessionIdOf('sxfix:ac:session:t1:__checkpoint_latest')).toBe('t1');
    expect(preset.sessionIdOf('sxfix:ac:session:t1:checkpoint:abc')).toBe('t1');
    expect(preset.sessionIdOf('sxfix:ac:session:t1:writes:abc%7Ctask%7Cmessages%7C0')).toBe('t1');
    expect(preset.sessionIdOf('sxfix:ac:session:t1:unknown')).toBeNull();
    expect(preset.sessionIdOf('other:session:t1')).toBeNull();
    expect(preset.defaultPattern('sxfix:ac')).toBe('sxfix:ac:session:*');
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
    expect(preset.parseKey({ ...source, value: { base64: '//4A' } }).parsed).toBe(false);
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

  it('raw preset never parses', () => {
    const preset = getPreset('raw');
    expect(preset.sessionIdOf('a:b')).toBe('a:b');
    const view = preset.parseKey({ key: 'a:b', type: 'string', pttl: -1, value: 'x' });
    expect(view).toMatchObject({ parsed: false, reason: 'No schema configured' });
  });
});

describe('decodeValue', () => {
  it('non-utf8 value falls back to base64 raw', () => {
    expect(decodeValue(Buffer.from([0xff, 0xfe, 0x00]), 1024).value).toEqual({ base64: '//4A' });
  });

  it('returns utf8 text unchanged', () => {
    expect(decodeValue(Buffer.from('héllo 🚀', 'utf8'), 1024)).toEqual({ value: 'héllo 🚀', truncated: false });
  });

  it('truncates at cap', () => {
    const cap = 2 * 1024 * 1024;
    const result = decodeValue(Buffer.alloc(3 * 1024 * 1024, 'a'), cap);
    expect(result.truncated).toBe(true);
    expect((result.value as string).length).toBe(cap);
  });

  it('does not report a multibyte cut at the cap as binary', () => {
    const result = decodeValue(Buffer.from('aé', 'utf8'), 2);
    expect(result.truncated).toBe(true);
    expect(result.value).toBe('a');
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
