import type { CapturedKey, CustomSchema, ParsedMessage } from '@betterdb/shared';
import type { PresetDefinition } from './types';
import { fail, failedView, guardedParse, isRecord, parseJson, textContent } from './text';

const VALUE_TYPES = ['list', 'string', 'hash', 'json'] as const;
const MESSAGE_SOURCES = ['items', 'path', 'key'] as const;
const OPTIONAL_FIELDS = ['timestamp', 'toolName', 'toolArgs', 'toolResult'] as const;
const SESSION_GROUP = /\(\?<session>/;
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
      try {
        new RegExp(s.sessionRegex);
        if (!SESSION_GROUP.test(s.sessionRegex)) {
          errors.push('sessionRegex must contain a named group "session"');
        }
      } catch {
        errors.push('sessionRegex is not a valid regular expression');
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
  } else if (messages.from === 'path' && !isNonEmptyString(messages.path)) {
    errors.push('messages.path is required when messages.from is "path"');
  }

  const fields = s.fields;
  if (!isRecord(fields)) {
    errors.push('fields is required');
  } else {
    if (!isNonEmptyString(fields.role)) errors.push('fields.role is required');
    if (!isNonEmptyString(fields.content)) errors.push('fields.content is required');
    for (const name of OPTIONAL_FIELDS) {
      if (fields[name] !== undefined && !isNonEmptyString(fields[name])) {
        errors.push(`fields.${name} must be a non-empty string`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, schema: s as unknown as CustomSchema };
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
  const message: ParsedMessage = { role, content: textContent(rawContent) };

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
