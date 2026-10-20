import * as fs from 'fs';
import * as path from 'path';
import type { CapturedKey, CustomSchema } from '@betterdb/shared';
import { createCustomPreset, getPath, validateCustomSchema } from '../presets/custom';
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

  it('rejects a sessionRegex without a session group', () => {
    const result = validateCustomSchema({ ...baseSchema, sessionRegex: '^chat:(\\w+)$' });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid regex', () => {
    const result = validateCustomSchema({ ...baseSchema, sessionRegex: '(?<session>' });
    expect(result.ok).toBe(false);
  });

  it('accepts a sessionRegex with a session group', () => {
    const result = validateCustomSchema({ ...baseSchema, sessionRegex: '^chat:(?<session>\\w+)$' });
    expect(result.ok).toBe(true);
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

  it('rejects regexes that could backtrack catastrophically', () => {
    for (const sessionRegex of ['^(a+)+$', '(\\w+)*:(?<session>x)', '(?<session>(a*)*)']) {
      const result = validateCustomSchema({ ...baseSchema, sessionRegex });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.errors).toContain(
          'Session regex has nested repetition that could hang the server',
        );
      }
    }
  });

  it('rejects repeated alternation and optional repeats that backtrack exponentially', () => {
    for (const sessionRegex of [
      '^(?<session>(a|a)*)!$',
      '(?<session>(a|ab)+)',
      '(?<session>(a|a){1,100})',
      '(?<session>(a?){30}a{30})',
    ]) {
      const result = validateCustomSchema({ ...baseSchema, sessionRegex });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.errors).toContain(
          'Session regex has nested repetition that could hang the server',
        );
      }
    }
  });

  it('rejects more than three unbounded repeats', () => {
    for (const sessionRegex of ['(?<session>a*a*a*a*)!', '(?<session>.*):.*:.*:.*$']) {
      const result = validateCustomSchema({ ...baseSchema, sessionRegex });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.errors).toContain(
          'Session regex may use at most 3 unbounded repeats (*, +, {n,})',
        );
      }
    }
  });

  it('accepts common session regexes', () => {
    for (const sessionRegex of [
      '^chat:(?<session>[^:]+):msg:\\d+$',
      '^(?<session>.+)$',
      '^(?:a|b):(?<session>\\w{1,8})-\\d{1,3}$',
      '^app:(?<session>[^:]+)(?::.*)?$',
    ]) {
      expect(validateCustomSchema({ ...baseSchema, sessionRegex })).toMatchObject({ ok: true });
    }
  });

  it('matches accepted worst-case regexes against long keys quickly', () => {
    const preset = createCustomPreset({
      ...baseSchema,
      sessionRegex: '^(?<session>.*):.*:.*!$',
    } as CustomSchema);
    const started = Date.now();
    expect(preset.sessionIdOf(':'.repeat(5000))).toBeNull();
    expect(preset.sessionIdOf(':'.repeat(500))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects an over-long regex', () => {
    const result = validateCustomSchema({
      ...baseSchema,
      sessionRegex: `(?<session>${'a'.repeat(200)})`,
    });
    expect(result).toEqual({
      ok: false,
      errors: ['Session regex must be at most 200 characters'],
    });
  });

  it('accepts a normal regex', () => {
    const result = validateCustomSchema({
      ...baseSchema,
      sessionRegex: '^app:(?<session>[^:]+):',
    });
    expect(result.ok).toBe(true);
  });

  it('requires a real session group', () => {
    expect(validateCustomSchema({ ...baseSchema, sessionRegex: '\\(?<session>x' }).ok).toBe(false);
    expect(validateCustomSchema({ ...baseSchema, sessionRegex: '[(?<session>]' }).ok).toBe(false);
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

  it('treats each key as its own session without sessionRegex', () => {
    const preset = createCustomPreset(baseSchema);
    expect(preset.sessionIdOf('chat:abc')).toBe('chat:abc');
  });

  it('extracts the session group and ignores non-matching keys', () => {
    const preset = createCustomPreset({ ...baseSchema, sessionRegex: '^chat:(?<session>\\w+)$' });
    expect(preset.sessionIdOf('chat:abc')).toBe('abc');
    expect(preset.sessionIdOf('other:abc')).toBeNull();
  });

  it('returns null for oversized keys without running the regex', () => {
    const preset = createCustomPreset({ ...baseSchema, sessionRegex: '^(?<session>a+)$' });
    expect(preset.sessionIdOf('a'.repeat(2000))).toBeNull();
    expect(preset.sessionIdOf('aaa')).toBe('aaa');
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

  it('registry requires a schema for custom', () => {
    expect(() => getPreset('custom', null)).toThrow();
    expect(getPreset('custom', baseSchema).id).toBe('custom');
  });
});
