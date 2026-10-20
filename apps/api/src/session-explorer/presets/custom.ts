import type { CapturedKey, CustomSchema, ParsedMessage } from '@betterdb/shared';
import type { PresetDefinition } from './types';
import { fail, failedView, guardedParse, isRecord, parseJson, textContent } from './text';

const VALUE_TYPES = ['list', 'string', 'hash', 'json'] as const;
const MESSAGE_SOURCES = ['items', 'path', 'key'] as const;
const OPTIONAL_FIELDS = ['timestamp', 'toolName', 'toolArgs', 'toolResult'] as const;
const MAX_REGEX_LENGTH = 200;
const MAX_KEY_LENGTH = 512;
const BOUND = /^\{(\d+)(,(\d*))?\}/;
const MAX_SMALL_BOUND = 16;
const MAX_LARGE_REPEATS = 3;
const SEGMENT = /^([^.[\]]*)((?:\[\d+\])*)$/;
const INDEX = /\[(\d+)\]/g;

export function getPath(obj: unknown, path: string): unknown {
  if (path === '') return undefined;
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    const match = SEGMENT.exec(segment);
    if (!match || (match[1] === '' && match[2] === '')) return undefined;
    const [, name, indices] = match;
    if (name !== '') {
      if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, name)) {
        return undefined;
      }
      current = current[name];
    }
    for (const index of indices.matchAll(INDEX)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index[1])];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

const isValidPath = (path: string): boolean =>
  path.split('.').every((segment) => {
    const match = SEGMENT.exec(segment);
    return match !== null && !(match[1] === '' && match[2] === '');
  });

interface Quantifier {
  length: number;
  large: boolean;
}

interface GroupFrame {
  repeats: boolean;
  alternates: boolean;
}

function quantifierAt(src: string, i: number): Quantifier | null {
  let q: Quantifier | null = null;
  if (src[i] === '*' || src[i] === '+') {
    q = { length: 1, large: true };
  } else if (src[i] === '?') {
    q = { length: 1, large: false };
  } else if (src[i] === '{') {
    const bound = BOUND.exec(src.slice(i));
    if (!bound) return null;
    const max =
      bound[2] === undefined ? Number(bound[1]) : bound[3] === '' ? Infinity : Number(bound[3]);
    q = { length: bound[0].length, large: max > MAX_SMALL_BOUND };
  }
  if (q && src[i + q.length] === '?') q.length++;
  return q;
}

function groupSyntaxLength(src: string, i: number): number {
  if (src[i + 1] !== '?') return 0;
  if (src.startsWith('<=', i + 2) || src.startsWith('<!', i + 2)) return 3;
  if (src[i + 2] === '<') return src.indexOf('>', i) - i;
  return 2;
}

function repetitionRisk(src: string): { nested: boolean; largeRepeats: number } {
  const stack: GroupFrame[] = [];
  let inClass = false;
  let nested = false;
  let largeRepeats = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
    } else if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '(') {
      stack.push({ repeats: false, alternates: false });
      i += groupSyntaxLength(src, i);
    } else if (c === '|') {
      if (stack.length > 0) stack[stack.length - 1].alternates = true;
    } else if (c === ')') {
      const frame = stack.pop() ?? { repeats: false, alternates: false };
      if (quantifierAt(src, i + 1)?.large && (frame.repeats || frame.alternates)) nested = true;
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.repeats ||= frame.repeats;
        parent.alternates ||= frame.alternates;
      }
    } else {
      const q = quantifierAt(src, i);
      if (q) {
        if (q.large) largeRepeats++;
        if (stack.length > 0) stack[stack.length - 1].repeats = true;
        i += q.length - 1;
      }
    }
  }
  return { nested, largeRepeats };
}

const hasSessionGroup = (src: string): boolean =>
  'session' in (new RegExp(`(?:${src})|`).exec('')?.groups ?? {});

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function validateCustomSchema(
  s: unknown,
): { ok: true; schema: CustomSchema } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(s)) return { ok: false, errors: ['Schema must be an object'] };

  if (s.sessionRegex !== undefined) {
    if (typeof s.sessionRegex !== 'string') {
      errors.push('sessionRegex must be a string');
    } else {
      const src = s.sessionRegex;
      if (src.length > MAX_REGEX_LENGTH) {
        errors.push(`Session regex must be at most ${MAX_REGEX_LENGTH} characters`);
      } else {
        try {
          new RegExp(src);
          if (!hasSessionGroup(src)) {
            errors.push('sessionRegex must contain a named group "session"');
          }
          const risk = repetitionRisk(src);
          if (risk.nested) {
            errors.push('Session regex has nested repetition that could hang the server');
          }
          if (risk.largeRepeats > MAX_LARGE_REPEATS) {
            errors.push(
              `Session regex may use at most ${MAX_LARGE_REPEATS} unbounded repeats (*, +, {n,})`,
            );
          }
        } catch {
          errors.push('sessionRegex is not a valid regular expression');
        }
      }
    }
  }

  if (!VALUE_TYPES.includes(s.valueType as (typeof VALUE_TYPES)[number])) {
    errors.push('valueType must be one of list, string, hash, json');
  }

  const messages = s.messages;
  if (
    !isRecord(messages) ||
    !MESSAGE_SOURCES.includes(messages.from as (typeof MESSAGE_SOURCES)[number])
  ) {
    errors.push('messages.from must be one of items, path, key');
  } else if (messages.from === 'path') {
    if (!isNonEmptyString(messages.path)) {
      errors.push('messages.path is required when messages.from is "path"');
    } else if (!isValidPath(messages.path)) {
      errors.push('messages.path is not a valid path');
    }
  }

  const fields = s.fields;
  if (!isRecord(fields)) {
    errors.push('fields is required');
  } else {
    for (const name of ['role', 'content'] as const) {
      if (!isNonEmptyString(fields[name])) errors.push(`fields.${name} is required`);
      else if (!isValidPath(fields[name])) errors.push(`fields.${name} is not a valid path`);
    }
    for (const name of OPTIONAL_FIELDS) {
      const value = fields[name];
      if (value === undefined) continue;
      if (!isNonEmptyString(value)) errors.push(`fields.${name} must be a non-empty string`);
      else if (!isValidPath(value)) errors.push(`fields.${name} is not a valid path`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const input = s as unknown as CustomSchema;
  const schema: CustomSchema = {
    ...(input.sessionRegex !== undefined ? { sessionRegex: input.sessionRegex } : {}),
    valueType: input.valueType,
    messages:
      input.messages.from === 'path'
        ? { from: 'path', path: input.messages.path }
        : { from: input.messages.from },
    fields: {
      role: input.fields.role,
      content: input.fields.content,
      ...Object.fromEntries(
        OPTIONAL_FIELDS.filter((name) => input.fields[name] !== undefined).map((name) => [
          name,
          input.fields[name],
        ]),
      ),
    },
  };
  return { ok: true, schema };
}

const TYPE_MATCHES: Record<CustomSchema['valueType'], string[]> = {
  list: ['list'],
  string: ['string'],
  hash: ['hash'],
  json: ['string', 'ReJSON-RL'],
};

const parseIfString = (v: unknown): unknown => (typeof v === 'string' ? parseJson(v) : v);

const parseIfJson = (v: string): unknown => {
  try {
    return parseJson(v);
  } catch {
    return v;
  }
};

function readRoot(k: CapturedKey, valueType: CustomSchema['valueType']): unknown {
  switch (valueType) {
    case 'list':
      if (!Array.isArray(k.value)) return fail('Expected a list value');
      return k.value.map(parseIfString);
    case 'hash':
      if (!isRecord(k.value)) return fail('Expected a hash value');
      return Object.fromEntries(
        Object.entries(k.value).map(([field, v]) => [
          field,
          typeof v === 'string' ? parseIfJson(v) : v,
        ]),
      );
    default:
      if (k.type === 'ReJSON-RL' && typeof k.value !== 'string') return k.value;
      if (typeof k.value !== 'string') return fail('Expected a string value');
      return parseJson(k.value);
  }
}

function selectEntries(root: unknown, schema: CustomSchema): unknown[] {
  switch (schema.messages.from) {
    case 'key':
      return [root];
    case 'items': {
      if (Array.isArray(root)) return root;
      if (schema.valueType === 'hash' && isRecord(root)) return Object.values(root);
      return fail('Value has no message items');
    }
    case 'path': {
      const found = getPath(root, schema.messages.path);
      if (!Array.isArray(found)) return fail(`No message list at "${schema.messages.path}"`);
      return found;
    }
  }
}

function toMessage(entry: unknown, fields: CustomSchema['fields']): ParsedMessage {
  const role = getPath(entry, fields.role);
  if (typeof role !== 'string' || role === '') return fail(`Missing role at "${fields.role}"`);
  const rawContent = getPath(entry, fields.content);
  if (rawContent === undefined) return fail(`Missing content at "${fields.content}"`);
  const message: ParsedMessage = { role, content: textContent(rawContent ?? '') };

  if (fields.timestamp) {
    const ts = getPath(entry, fields.timestamp);
    if (typeof ts === 'string' || typeof ts === 'number') message.timestamp = String(ts);
  }
  const toolName = fields.toolName ? getPath(entry, fields.toolName) : undefined;
  const hasToolName = typeof toolName === 'string' && toolName !== '';
  if (hasToolName) {
    message.toolCalls = [
      { name: toolName, args: fields.toolArgs ? getPath(entry, fields.toolArgs) : undefined },
    ];
  }
  const toolResult = fields.toolResult ? getPath(entry, fields.toolResult) : undefined;
  if (toolResult !== undefined) {
    message.toolResult = {
      ...(hasToolName ? { name: toolName } : {}),
      content: toolResult,
    };
  }
  return message;
}

export function createCustomPreset(schema: CustomSchema): PresetDefinition {
  const sessionRegex = schema.sessionRegex ? new RegExp(schema.sessionRegex) : null;
  const expectedTypes = TYPE_MATCHES[schema.valueType];
  return {
    id: 'custom',
    defaultPattern: (prefix) => `${prefix}*`,
    sessionIdOf: (key) => {
      if (!sessionRegex) return key;
      if (key.length > MAX_KEY_LENGTH) return null;
      return sessionRegex.exec(key)?.groups?.session || null;
    },
    parseKey: (k) => {
      if (!expectedTypes.includes(k.type)) {
        return failedView(k, `Expected ${schema.valueType}, found ${k.type}`);
      }
      return guardedParse(k, () =>
        selectEntries(readRoot(k, schema.valueType), schema).map((entry) =>
          toMessage(entry, schema.fields),
        ),
      );
    },
    mergeSession: (views) => views.flatMap((v) => (v.parsed ? v.messages : [])),
  };
}
