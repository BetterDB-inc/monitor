import type { CapturedKey, KeyView, ParsedMessage, PresetId } from '@betterdb/shared';

export type SessionLookup = { key: string } | { match: string };

export interface PresetDefinition {
  id: PresetId;
  defaultPattern: (prefix: string) => string;
  sessionIdOf(key: string): string | null;
  sessionLookup?(sessionId: string): SessionLookup;
  parseKey(k: CapturedKey): KeyView;
  selectKeys?(keys: string[]): string[];
  parseKeys?(keys: CapturedKey[]): KeyView[];
  mergeSession(keys: KeyView[]): ParsedMessage[];
}
