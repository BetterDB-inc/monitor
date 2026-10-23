import type { PresetId, SessionNamespaceInput } from '@betterdb/shared';
import { validateCustomSchema } from './presets/custom';

export const DEFAULT_OVERSIZE_THRESHOLD_BYTES = 1048576;
export const MAX_NAME_LENGTH = 200;
export const MAX_PATTERN_LENGTH = 1024;

const PRESET_IDS: readonly PresetId[] = [
  'langchain-community',
  'langchain-js',
  'llamaindex',
  'agent-cache',
  'custom',
  'raw',
];

const GLOB_METACHARACTERS = new Set(['*', '?', '[']);

const hasLiteralPrefix = (pattern: string): boolean =>
  pattern.length > 0 && !GLOB_METACHARACTERS.has(pattern[0]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateNamespaceInput(
  input: unknown,
): { ok: true; value: SessionNamespaceInput } | { ok: false; errors: string[] } {
  if (!isRecord(input)) return { ok: false, errors: ['Body must be an object'] };

  const errors: string[] = [];

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') errors.push('Name is required');
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`Name must be at most ${MAX_NAME_LENGTH} characters`);
  }

  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
  if (!hasLiteralPrefix(pattern)) errors.push('Pattern must include a literal prefix');
  if (/\s/.test(pattern)) errors.push('Pattern must not contain whitespace');
  if (pattern.length > MAX_PATTERN_LENGTH) {
    errors.push(`Pattern must be at most ${MAX_PATTERN_LENGTH} characters`);
  }

  const preset = PRESET_IDS.find((id) => id === input.preset);
  if (!preset) errors.push('Unknown preset');

  const threshold = input.oversizeThresholdBytes ?? DEFAULT_OVERSIZE_THRESHOLD_BYTES;
  const thresholdValid =
    typeof threshold === 'number' && Number.isSafeInteger(threshold) && threshold > 0;
  if (!thresholdValid) errors.push('Oversize threshold must be a positive integer');

  let customSchema: SessionNamespaceInput['customSchema'] = null;
  if (preset === 'custom') {
    if (input.customSchema === null || input.customSchema === undefined) {
      errors.push('Custom preset requires a schema');
    } else {
      const result = validateCustomSchema(input.customSchema);
      if (result.ok) customSchema = result.schema;
      else errors.push(...result.errors);
    }
  }

  if (errors.length > 0 || !preset || !thresholdValid) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      pattern,
      preset,
      customSchema,
      oversizeThresholdBytes: threshold,
    },
  };
}
