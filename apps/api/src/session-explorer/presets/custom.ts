import type { CapturedKey, CustomSchema, ParsedMessage } from '@betterdb/shared';
import type { PresetDefinition } from './types';
import {
  concatSession,
  fail,
  failedView,
  guardedParse,
  isRecord,
  parseJson,
  textContent,
} from './text';

const VALUE_TYPES = ['list', 'string', 'hash', 'json'] as const;
const MESSAGE_SOURCES = ['items', 'path', 'key'] as const;
const OPTIONAL_FIELDS = ['timestamp', 'toolName', 'toolArgs', 'toolResult'] as const;
const MAX_TEMPLATE_LENGTH = 200;
const SESSION_TOKEN = '{session}';
const WILDCARD = '*';
const SEGMENT = /^([^.[\]]*)((?:\[\d+\])*)$/;
const INDEX = /\[(\d+)\]/g;

const asIs = (v: unknown): unknown => v;

export function getPath(
  obj: unknown,
  path: string,
  open: (v: unknown) => unknown = asIs,
): unknown {
  if (path === '') return undefined;
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    const match = SEGMENT.exec(segment);
    if (!match || (match[1] === '' && match[2] === '')) return undefined;
    const [, name, indices] = match;
    if (name !== '') {
      current = open(current);
      if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, name)) {
        return undefined;
      }
      current = current[name];
    }
    for (const index of indices.matchAll(INDEX)) {
      current = open(current);
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

type Gap = 'session' | 'wildcard';

interface SessionTemplate {
  literals: string[];
  gaps: Gap[];
}

export function parseSessionTemplate(template: string): SessionTemplate {
  const literals: string[] = [];
  const gaps: Gap[] = [];
  let literal = '';
  for (let i = 0; i < template.length; i++) {
    if (template.startsWith(SESSION_TOKEN, i)) {
      literals.push(literal);
      gaps.push('session');
      literal = '';
      i += SESSION_TOKEN.length - 1;
    } else if (template[i] === WILDCARD) {
      literals.push(literal);
      gaps.push('wildcard');
      literal = '';
    } else {
      literal += template[i];
    }
  }
  literals.push(literal);
  return { literals, gaps };
}

function templateErrors(template: string): string[] {
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return [`Session template must be at most ${MAX_TEMPLATE_LENGTH} characters`];
  }
  const { literals, gaps } = parseSessionTemplate(template);
  const errors: string[] = [];
  if (gaps.filter((gap) => gap === 'session').length !== 1) {
    errors.push('Session template must contain {session} exactly once');
  }
  if (literals.slice(1, -1).some((literal) => literal === '')) {
    errors.push('Session template needs text between {session} and *');
  }
  return errors;
}

export function matchSessionTemplate(template: SessionTemplate, key: string): string | null {
  const { literals, gaps } = template;
  const first = literals[0];
  const last = literals[literals.length - 1];
  if (key.length < first.length + last.length) return null;
  if (!key.startsWith(first) || !key.endsWith(last)) return null;
  const end = key.length - last.length;
  let pos = first.length;
  let session: string | null = null;
  for (let i = 0; i < gaps.length; i++) {
    const isLast = i === gaps.length - 1;
    const next = literals[i + 1];
    const stop = isLast ? end : key.indexOf(next, pos);
    if (stop < 0 || stop > end || (!isLast && stop + next.length > end)) return null;
    if (gaps[i] === 'session') session = key.slice(pos, stop);
    pos = isLast ? end : stop + next.length;
  }
  return session || null;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export function validateCustomSchema(
  s: unknown,
): { ok: true; schema: CustomSchema } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(s)) return { ok: false, errors: ['Schema must be an object'] };

  if (!isBlank(s.sessionTemplate)) {
    if (typeof s.sessionTemplate !== 'string') errors.push('sessionTemplate must be a string');
    else errors.push(...templateErrors(s.sessionTemplate));
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
      if (isBlank(value)) continue;
      if (!isNonEmptyString(value)) errors.push(`fields.${name} must be a non-empty string`);
      else if (!isValidPath(value)) errors.push(`fields.${name} is not a valid path`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const input = s as unknown as CustomSchema;
  const schema: CustomSchema = {
    ...(!isBlank(input.sessionTemplate) ? { sessionTemplate: input.sessionTemplate } : {}),
    valueType: input.valueType,
    messages:
      input.messages.from === 'path'
        ? { from: 'path', path: input.messages.path }
        : { from: input.messages.from },
    fields: {
      role: input.fields.role,
      content: input.fields.content,
      ...Object.fromEntries(
        OPTIONAL_FIELDS.filter((name) => !isBlank(input.fields[name])).map((name) => [
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

const JSON_CONTAINER = /^\s*[[{]/;

const parseIfJson = (v: unknown): unknown => {
  if (typeof v !== 'string' || !JSON_CONTAINER.test(v)) return v;
  try {
    return parseJson(v);
  } catch {
    return v;
  }
};

const fieldOrder = new Intl.Collator('en', { numeric: true });

const byFieldName = (hash: Record<string, unknown>): unknown[] =>
  Object.entries(hash)
    .sort(([a], [b]) => fieldOrder.compare(a, b))
    .map(([, value]) => value);

function readRoot(k: CapturedKey, valueType: CustomSchema['valueType']): unknown {
  switch (valueType) {
    case 'list':
      if (!Array.isArray(k.value)) return fail('Expected a list value');
      return k.value.map(parseIfString);
    case 'hash':
      if (!isRecord(k.value)) return fail('Expected a hash value');
      return k.value;
    default:
      if (k.type === 'ReJSON-RL' && typeof k.value !== 'string') return k.value;
      if (typeof k.value !== 'string') return fail('Expected a string value');
      return parseJson(k.value);
  }
}

function selectEntries(
  root: unknown,
  schema: CustomSchema,
  open: (v: unknown) => unknown,
): unknown[] {
  switch (schema.messages.from) {
    case 'key':
      return [root];
    case 'items': {
      if (Array.isArray(root)) return root;
      if (schema.valueType === 'hash' && isRecord(root)) return byFieldName(root);
      return fail('Value has no message items');
    }
    case 'path': {
      const found = open(getPath(root, schema.messages.path, open));
      if (!Array.isArray(found)) return fail(`No message list at "${schema.messages.path}"`);
      return found;
    }
  }
}

function toMessage(
  entry: unknown,
  fields: CustomSchema['fields'],
  open: (v: unknown) => unknown,
): ParsedMessage {
  const at = (path: string) => getPath(entry, path, open);
  const role = at(fields.role);
  if (typeof role !== 'string' || role === '') return fail(`Missing role at "${fields.role}"`);
  const rawContent = at(fields.content);
  if (rawContent === undefined) return fail(`Missing content at "${fields.content}"`);
  const message: ParsedMessage = { role, content: textContent(rawContent ?? '') };

  if (fields.timestamp) {
    const ts = at(fields.timestamp);
    if (typeof ts === 'string' || typeof ts === 'number') message.timestamp = String(ts);
  }
  const toolName = fields.toolName ? at(fields.toolName) : undefined;
  const hasToolName = typeof toolName === 'string' && toolName !== '';
  if (hasToolName) {
    message.toolCalls = [
      { name: toolName, args: fields.toolArgs ? at(fields.toolArgs) : undefined },
    ];
  }
  const toolResult = fields.toolResult ? at(fields.toolResult) : undefined;
  if (toolResult !== undefined) {
    message.toolResult = {
      ...(hasToolName ? { name: toolName } : {}),
      content: toolResult,
    };
  }
  return message;
}

export function createCustomPreset(schema: CustomSchema): PresetDefinition {
  const template = schema.sessionTemplate ? parseSessionTemplate(schema.sessionTemplate) : null;
  const expectedTypes = TYPE_MATCHES[schema.valueType];
  const open = schema.valueType === 'hash' ? parseIfJson : asIs;
  return {
    id: 'custom',
    defaultPattern: (prefix) => `${prefix}*`,
    sessionIdOf: (key) => (template ? matchSessionTemplate(template, key) : key),
    parseKey: (k) => {
      if (!expectedTypes.includes(k.type)) {
        return failedView(k, `Expected ${schema.valueType}, found ${k.type}`);
      }
      return guardedParse(k, () =>
        selectEntries(readRoot(k, schema.valueType), schema, open).map((entry) =>
          toMessage(entry, schema.fields, open),
        ),
      );
    },
    mergeSession: concatSession,
  };
}
