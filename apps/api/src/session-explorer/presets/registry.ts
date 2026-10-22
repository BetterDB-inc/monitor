import type { CapturedKey, CustomSchema, KeyView, PresetId } from '@betterdb/shared';
import type { PresetDefinition } from './types';
import { agentCachePreset } from './agent-cache';
import { langchainCommunityPreset } from './langchain-community';
import { llamaindexPreset } from './llamaindex';
import { createCustomPreset } from './custom';
import { failedView } from './text';

const langchainJsPreset: PresetDefinition = {
  ...langchainCommunityPreset,
  id: 'langchain-js',
  defaultPattern: (prefix) => `${prefix}*`,
};

const rawPreset: PresetDefinition = {
  id: 'raw',
  defaultPattern: (prefix) => `${prefix}*`,
  sessionIdOf: (key) => key,
  parseKey: (k) => failedView(k, 'No schema configured'),
  mergeSession: () => [],
};

export function getPreset(id: PresetId, custom?: CustomSchema | null): PresetDefinition {
  switch (id) {
    case 'langchain-community':
      return langchainCommunityPreset;
    case 'langchain-js':
      return langchainJsPreset;
    case 'llamaindex':
      return llamaindexPreset;
    case 'agent-cache':
      return agentCachePreset;
    case 'raw':
      return rawPreset;
    case 'custom':
      if (!custom) throw new Error('Custom preset requires a schema');
      return createCustomPreset(custom);
  }
}

export const parseSessionKeys = (preset: PresetDefinition, keys: CapturedKey[]): KeyView[] =>
  preset.parseKeys ? preset.parseKeys(keys) : keys.map((k) => preset.parseKey(k));
