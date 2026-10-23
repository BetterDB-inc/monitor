import {
  escapeGlob,
  type CapturedKey,
  type CustomSchema,
  type KeyView,
  type PresetId,
} from '@betterdb/shared';
import type { PresetDefinition } from './types';
import { createAgentCachePreset } from './agent-cache';
import { langchainCommunityPreset } from './langchain-community';
import { llamaindexPreset } from './llamaindex';
import { createCustomPreset, validateCustomSchema } from './custom';
import { failedView } from './text';

const langchainJsPreset: PresetDefinition = {
  ...langchainCommunityPreset,
  id: 'langchain-js',
  defaultPattern: (prefix) => `${escapeGlob(prefix)}*`,
};

const rawPreset: PresetDefinition = {
  id: 'raw',
  defaultPattern: (prefix) => `${escapeGlob(prefix)}*`,
  sessionIdOf: (key) => key,
  parseKey: (k) => failedView(k, 'No schema configured'),
  mergeSession: () => [],
};

const invalidSchemaPreset = (errors: string[]): PresetDefinition => ({
  ...rawPreset,
  id: 'custom',
  parseKey: (k) => failedView(k, `Invalid custom schema: ${errors.join('; ')}`),
});

function customPreset(custom: CustomSchema | null | undefined): PresetDefinition {
  const result = validateCustomSchema(custom);
  return result.ok ? createCustomPreset(result.schema) : invalidSchemaPreset(result.errors);
}

export function getPreset(
  id: PresetId,
  custom?: CustomSchema | null,
  pattern?: string,
): PresetDefinition {
  switch (id) {
    case 'langchain-community':
      return langchainCommunityPreset;
    case 'langchain-js':
      return langchainJsPreset;
    case 'llamaindex':
      return llamaindexPreset;
    case 'agent-cache':
      return createAgentCachePreset(pattern);
    case 'raw':
      return rawPreset;
    case 'custom':
      return customPreset(custom);
    default:
      throw new Error(`Unknown preset "${id as string}"`);
  }
}

export const parseSessionKeys = (preset: PresetDefinition, keys: CapturedKey[]): KeyView[] =>
  preset.parseKeys ? preset.parseKeys(keys) : keys.map((k) => preset.parseKey(k));
