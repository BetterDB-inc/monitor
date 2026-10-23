import * as fs from 'fs';
import * as path from 'path';
import type { CapturedKey, CustomSchema } from '@betterdb/shared';
import {
  createCustomPreset,
  getPath,
  matchSessionTemplate,
  parseSessionTemplate,
  validateCustomSchema,
} from '../presets/custom';
import { getPreset } from '../presets/registry';

const FIXTURE = path.join(
  __dirname,
  '../../../test/fixtures/session-explorer/langchain-community@0.4.2.json',
);

const fixture: { keys: CapturedKey[] } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const baseSchema: CustomSchema = {
  valueType: 'list',
  messages: { from: 'items' },
  fields: { role: 'type', content: 'data.content' },
};

const key = (overrides: Partial<CapturedKey>): CapturedKey => ({
  key: 'k',
  type: 'string',
  pttl: -1,
  value: '',
  ...overrides,
});

describe('getPath', () => {
  it('resolves dotted paths with indices', () => {
    expect(getPath({ a: { b: [{ c: 1 }] } }, 'a.b[0].c')).toBe(1);
  });

  it('returns undefined for missing segments', () => {
    expect(getPath({ a: { b: [{ c: 1 }] } }, 'a.x.c')).toBeUndefined();
    expect(getPath({ a: { b: [{ c: 1 }] } }, 'a.b[3].c')).toBeUndefined();
  });

  it('returns undefined for empty segments', () => {
    expect(getPath({ a: { b: 1 } }, 'a..b')).toBeUndefined();
  });

  it('supports a leading index on array roots', () => {
    expect(getPath([{ x: 'y' }], '[0].x')).toBe('y');
  });

  it('does not read inherited properties', () => {
    expect(getPath({}, 'constructor')).toBeUndefined();
    expect(getPath({}, '__proto__')).toBeUndefined();
  });
});

describe('validateCustomSchema', () => {
  it('accepts a valid schema', () => {
    expect(validateCustomSchema(baseSchema)).toEqual({ ok: true, schema: baseSchema });
  });

  it('rejects a sessionTemplate without {session}', () => {
    expect(validateCustomSchema({ ...baseSchema, sessionTemplate: 'chat:*' })).toEqual({
      ok: false,
      errors: ['Session template must contain {session} exactly once'],
    });
  });

  it('rejects a sessionTemplate with {session} twice', () => {
    const result = validateCustomSchema({ ...baseSchema, sessionTemplate: '{session}:{session}' });
    expect(result.ok).toBe(false);
  });

  it('rejects adjacent gaps that make the session ambiguous', () => {
    for (const sessionTemplate of ['chat:{session}*', 'chat:*{session}', 'a:**:{session}']) {
      expect(validateCustomSchema({ ...baseSchema, sessionTemplate })).toEqual({
        ok: false,
        errors: ['Session template needs text between {session} and *'],
      });
    }
  });

  it('accepts a sessionTemplate with {session}', () => {
    const result = validateCustomSchema({ ...baseSchema, sessionTemplate: 'chat:{session}:*' });
    expect(result).toEqual({
      ok: true,
      schema: { ...baseSchema, sessionTemplate: 'chat:{session}:*' },
    });
  });

  it('rejects a non-string sessionTemplate', () => {
    expect(validateCustomSchema({ ...baseSchema, sessionTemplate: 7 }).ok).toBe(false);
  });

  it('treats blank optional inputs as not set', () => {
    for (const blank of ['', '   ', null]) {
      const result = validateCustomSchema({
        ...baseSchema,
        sessionTemplate: blank,
        fields: { ...baseSchema.fields, timestamp: blank, toolName: blank },
      });
      expect(result).toEqual({ ok: true, schema: baseSchema });
    }
  });

  it('trims pasted inputs and rejects whitespace-only required fields', () => {
    expect(
      validateCustomSchema({
        ...baseSchema,
        sessionTemplate: ' chat:{session} ',
        messages: { from: 'path', path: ' turns ' },
        fields: { role: ' type ', content: 'data.content\n', toolName: ' tool ' },
      }),
    ).toEqual({
      ok: true,
      schema: {
        ...baseSchema,
        sessionTemplate: 'chat:{session}',
        messages: { from: 'path', path: 'turns' },
        fields: { role: 'type', content: 'data.content', toolName: 'tool' },
      },
    });
    expect(
      validateCustomSchema({ ...baseSchema, fields: { role: '   ', content: 'c' } }),
    ).toEqual({ ok: false, errors: ['fields.role is required'] });
  });

  it('rejects missing role or content', () => {
    const noRole = validateCustomSchema({ ...baseSchema, fields: { content: 'c' } });
    const noContent = validateCustomSchema({ ...baseSchema, fields: { role: 'r' } });
    expect(noRole.ok).toBe(false);
    expect(noContent.ok).toBe(false);
  });

  it('rejects messages.from path without a path', () => {
    const result = validateCustomSchema({ ...baseSchema, messages: { from: 'path' } });
    expect(result.ok).toBe(false);
  });

  it('rejects an over-long template', () => {
    const result = validateCustomSchema({
      ...baseSchema,
      sessionTemplate: `{session}${'a'.repeat(200)}`,
    });
    expect(result).toEqual({
      ok: false,
      errors: ['Session template must be at most 200 characters'],
    });
  });

  it('rejects malformed paths and names the field', () => {
    const badContent = validateCustomSchema({
      ...baseSchema,
      fields: { role: 'type', content: 'a..b' },
    });
    expect(badContent).toEqual({ ok: false, errors: ['fields.content is not a valid path'] });
    const badPath = validateCustomSchema({
      ...baseSchema,
      messages: { from: 'path', path: 'a[' },
    });
    expect(badPath).toEqual({ ok: false, errors: ['messages.path is not a valid path'] });
    const badOptional = validateCustomSchema({
      ...baseSchema,
      fields: { role: 'type', content: 'c', toolName: 'x[' },
    });
    expect(badOptional.ok).toBe(false);
  });

  it('drops unknown properties', () => {
    const result = validateCustomSchema({
      ...baseSchema,
      extra: 1,
      fields: { ...baseSchema.fields, junk: 'x' },
    });
    expect(result).toEqual({ ok: true, schema: baseSchema });
  });

  it('rejects unknown valueType and non-object input', () => {
    expect(validateCustomSchema({ ...baseSchema, valueType: 'set' }).ok).toBe(false);
    expect(validateCustomSchema(null).ok).toBe(false);
  });
});

describe('custom preset', () => {
  it('parses the langchain-community fixture with the same message count as the preset', () => {
    const custom = createCustomPreset(baseSchema);
    const builtin = getPreset('langchain-community');
    expect(fixture.keys.length).toBeGreaterThan(0);
    for (const k of fixture.keys) {
      const expected = builtin.parseKey(k);
      const actual = custom.parseKey(k);
      expect(expected.parsed).toBe(true);
      expect(actual.parsed).toBe(true);
      if (expected.parsed && actual.parsed) {
        expect(actual.messages).toHaveLength(expected.messages.length);
        expect(actual.messages.map((m) => m.content).sort()).toEqual(
          expected.messages.map((m) => m.content).sort(),
        );
      }
    }
  });

  it('reports a type mismatch', () => {
    const preset = createCustomPreset({ ...baseSchema, valueType: 'hash' });
    const view = preset.parseKey(key({ type: 'list', value: ['{}'] }));
    expect(view).toMatchObject({ parsed: false, reason: 'Expected hash, found list' });
  });

  it('treats each key as its own session without sessionTemplate', () => {
    const preset = createCustomPreset(baseSchema);
    expect(preset.sessionIdOf('chat:abc')).toBe('chat:abc');
  });

  it('extracts the session from the template and ignores non-matching keys', () => {
    const preset = createCustomPreset({ ...baseSchema, sessionTemplate: 'chat:{session}' });
    expect(preset.sessionIdOf('chat:abc')).toBe('abc');
    expect(preset.sessionIdOf('other:abc')).toBeNull();
    expect(preset.sessionIdOf('chat:')).toBeNull();
  });

  it('matches a suffix and wildcards around the session', () => {
    const t = (template: string, key: string) =>
      matchSessionTemplate(parseSessionTemplate(template), key);
    expect(t('app:{session}:messages', 'app:t1:messages')).toBe('t1');
    expect(t('app:{session}:messages', 'app:t1:meta')).toBeNull();
    expect(t('app:{session}:*', 'app:t1:meta:2')).toBe('t1');
    expect(t('*:session:{session}:*', 'cache:session:t1:last')).toBe('t1');
    expect(t('*:session:{session}:*', 'app:session:store:session:t1:checkpoint:abc')).toBe('t1');
    expect(t('*:{session}:*', 'a:b:c:d')).toBe('c');
    expect(t('*:session:{session}', 'a:session:b:session:')).toBe('b:session:');
    expect(t('{session}', 'anything')).toBe('anything');
    expect(t('ab{session}ba', 'aba')).toBeNull();
  });

  it('matches hostile keys in linear time', () => {
    const preset = createCustomPreset({ ...baseSchema, sessionTemplate: '*a*a*a:{session}=' });
    const started = Date.now();
    expect(preset.sessionIdOf('a'.repeat(100_000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads messages from a path inside a JSON string', () => {
    const preset = createCustomPreset({
      valueType: 'json',
      messages: { from: 'path', path: 'conversation.turns' },
      fields: { role: 'who', content: 'text', timestamp: 'at', toolName: 'tool.name', toolArgs: 'tool.args' },
    });
    const value = JSON.stringify({
      conversation: {
        turns: [
          { who: 'user', text: 'hi', at: 1700000000 },
          { who: 'bot', text: 'ok', tool: { name: 'lookup', args: { q: 1 } } },
        ],
      },
    });
    const view = preset.parseKey(key({ value }));
    expect(view).toMatchObject({ parsed: true });
    if (view.parsed) {
      expect(view.messages[0]).toEqual({ role: 'user', content: 'hi', timestamp: '1700000000' });
      expect(view.messages[1].toolCalls).toEqual([{ name: 'lookup', args: { q: 1 } }]);
    }
  });

  it('reads one message per hash key with from key', () => {
    const preset = createCustomPreset({
      valueType: 'hash',
      messages: { from: 'key' },
      fields: { role: 'role', content: 'body' },
    });
    const view = preset.parseKey(key({ type: 'hash', value: { role: 'user', body: 'hello' } }));
    expect(view).toMatchObject({ parsed: true, messages: [{ role: 'user', content: 'hello' }] });
  });

  it('falls back to raw when a field is missing', () => {
    const preset = createCustomPreset(baseSchema);
    const view = preset.parseKey(key({ type: 'list', value: ['{"type":"human"}'] }));
    expect(view).toMatchObject({ parsed: false, reason: 'Missing content at "data.content"' });
  });

  it('falls back to raw when the value is not JSON', () => {
    const preset = createCustomPreset(baseSchema);
    const view = preset.parseKey(key({ type: 'list', value: ['nope'] }));
    expect(view).toMatchObject({ parsed: false, reason: 'Value is not valid JSON' });
  });

  it('reads a ReJSON document that was captured already parsed', () => {
    const preset = createCustomPreset({
      valueType: 'json',
      messages: { from: 'path', path: 'turns' },
      fields: { role: 'who', content: 'text' },
    });
    const view = preset.parseKey(
      key({ type: 'ReJSON-RL', value: { turns: [{ who: 'user', text: 'hi' }] } }),
    );
    expect(view).toMatchObject({ parsed: true, messages: [{ role: 'user', content: 'hi' }] });
  });

  it('reads null content next to a tool call as empty text', () => {
    const preset = createCustomPreset({
      valueType: 'list',
      messages: { from: 'items' },
      fields: { role: 'role', content: 'content', toolName: 'tool_calls[0].function.name' },
    });
    const entry = { role: 'assistant', content: null, tool_calls: [{ function: { name: 'lookup' } }] };
    const view = preset.parseKey(key({ type: 'list', value: [JSON.stringify(entry)] }));
    expect(view).toMatchObject({
      parsed: true,
      messages: [{ role: 'assistant', content: '', toolCalls: [{ name: 'lookup' }] }],
    });
  });

  it('parses a hash with a field named base64', () => {
    const preset = createCustomPreset({
      valueType: 'hash',
      messages: { from: 'key' },
      fields: { role: 'role', content: 'body' },
    });
    const view = preset.parseKey(
      key({ type: 'hash', value: { role: 'user', body: 'hello', base64: 'aGk=' } }),
    );
    expect(view).toMatchObject({ parsed: true, messages: [{ role: 'user', content: 'hello' }] });
  });

  it('keeps plain-text hash fields that look like JSON scalars as text', () => {
    const preset = createCustomPreset({
      valueType: 'hash',
      messages: { from: 'key' },
      fields: { role: 'role', content: 'body' },
    });
    for (const [role, body] of [
      ['user', '42'],
      ['user', 'null'],
      ['user', '"hi"'],
      ['true', 'yes'],
    ]) {
      const view = preset.parseKey(key({ type: 'hash', value: { role, body } }));
      expect(view).toMatchObject({ parsed: true, messages: [{ role, content: body }] });
    }
  });

  it('still parses JSON objects stored in hash fields', () => {
    const preset = createCustomPreset({
      valueType: 'hash',
      messages: { from: 'items' },
      fields: { role: 'role', content: 'text' },
    });
    const view = preset.parseKey(
      key({ type: 'hash', value: { m1: '{"role":"user","text":"hi"}' } }),
    );
    expect(view).toMatchObject({ parsed: true, messages: [{ role: 'user', content: 'hi' }] });
  });

  it('keeps hash fields read as message fields as text even when they hold JSON', () => {
    const preset = createCustomPreset({
      valueType: 'hash',
      messages: { from: 'key' },
      fields: { role: 'role', content: 'body' },
    });
    for (const body of ['{"city":"Sofia","tempC":21}', '[1,2,3]']) {
      const view = preset.parseKey(key({ type: 'hash', value: { role: 'tool', body } }));
      expect(view).toMatchObject({ parsed: true, messages: [{ role: 'tool', content: body }] });
    }
  });

  it('walks into JSON stored in a hash field when a path goes through it', () => {
    const preset = createCustomPreset({
      valueType: 'hash',
      messages: { from: 'path', path: 'history.turns' },
      fields: { role: 'meta.role', content: 'body' },
    });
    const history = JSON.stringify({
      turns: [{ meta: { role: 'user' }, body: '{"q":"weather"}' }],
    });
    const view = preset.parseKey(key({ type: 'hash', value: { history } }));
    expect(view).toMatchObject({
      parsed: true,
      messages: [{ role: 'user', content: '{"q":"weather"}' }],
    });
  });

  it('orders hash items by field name, numbers by value', () => {
    const preset = createCustomPreset({
      valueType: 'hash',
      messages: { from: 'items' },
      fields: { role: 'role', content: 'text' },
    });
    const msg = (text: string) => JSON.stringify({ role: 'user', text });
    const view = preset.parseKey(
      key({
        type: 'hash',
        value: { 'msg:10': msg('ten'), 'msg:2': msg('two'), 'msg:1': msg('one'), 3: msg('3') },
      }),
    );
    expect(view.parsed && view.messages.map((m) => m.content)).toEqual([
      '3',
      'one',
      'two',
      'ten',
    ]);
  });

  it('orders time-sortable ids in hash items by byte order', () => {
    const preset = createCustomPreset({
      valueType: 'hash',
      messages: { from: 'items' },
      fields: { role: 'role', content: 'text' },
    });
    const msg = (text: string) => JSON.stringify({ role: 'user', text });
    for (const [first, second] of [
      ['0190a3b2-10ab', '0190a3b2-9fff'],
      ['01J9X99A', '01J9X9A0'],
    ]) {
      const view = preset.parseKey(
        key({ type: 'hash', value: { [second]: msg('second'), [first]: msg('first') } }),
      );
      expect(view.parsed && view.messages.map((m) => m.content)).toEqual(['first', 'second']);
    }
  });

  it('registry requires a schema for custom', () => {
    expect(() => getPreset('custom', null)).toThrow();
    expect(getPreset('custom', baseSchema).id).toBe('custom');
  });

  it('registry turns an invalid stored schema into unparsed views', () => {
    const invalid = [
      { ...baseSchema, messages: { from: 'path' } },
      { ...baseSchema, valueType: 'set' },
    ] as unknown as CustomSchema[];
    for (const schema of invalid) {
      const preset = getPreset('custom', schema);
      const view = preset.parseKey(key({ type: 'list', value: ['{}'] }));
      expect(view.parsed).toBe(false);
      expect(view.parsed === false && view.reason).toMatch(/^Invalid custom schema: /);
      expect(preset.sessionIdOf('k')).toBe('k');
    }
  });

  it('registry throws on an unknown preset id', () => {
    expect(() => getPreset('bogus' as never)).toThrow('Unknown preset "bogus"');
  });
});
