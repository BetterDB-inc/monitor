export type PresetId =
  | 'langchain-community'
  | 'langchain-js'
  | 'llamaindex'
  | 'agent-cache'
  | 'custom'
  | 'raw';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ValkeyElement = string | { base64: string };

export type ValkeyValue =
  | string
  | ValkeyElement[]
  | Record<string, ValkeyElement>
  | Array<[ValkeyElement, number]>
  | JsonValue;

export interface CapturedKey {
  key: string;
  type: string;
  pttl: number;
  value: ValkeyValue;
  binary?: boolean;
  truncated?: boolean;
  bytes?: number;
}

export interface CustomSchema {
  sessionTemplate?: string;
  valueType: 'list' | 'string' | 'hash' | 'json';
  messages:
    | { from: 'items' }
    | { from: 'path'; path: string }
    | { from: 'key' };
  fields: {
    role: string;
    content: string;
    timestamp?: string;
    toolName?: string;
    toolArgs?: string;
    toolResult?: string;
  };
}

export interface SessionNamespace {
  id: string;
  connectionId: string;
  name: string;
  pattern: string;
  preset: PresetId;
  customSchema: CustomSchema | null;
  oversizeThresholdBytes: number;
  createdAt: number;
  updatedAt: number;
}

export type SessionNamespaceInput = Pick<
  SessionNamespace,
  'name' | 'pattern' | 'preset' | 'customSchema' | 'oversizeThresholdBytes'
>;

export interface SessionSummary {
  sessionId: string;
  keyCount: number;
  memoryBytes: number;
  unmeasuredKeys: number;
  idleSeconds: number | null;
  ttlMs: number | null;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  scannedKeys: number;
  truncated: boolean;
  partial: boolean;
  failedNodes: number;
  idleUntracked: boolean;
}

export interface ParsedMessage {
  role: string;
  content: string;
  timestamp?: string;
  toolCalls?: Array<{ name: string; args: unknown; id?: string }>;
  toolResult?: { name?: string; content: unknown; callId?: string };
}

export type KeyView = {
  key: string;
  type: string;
  ttlMs: number | null;
  raw: ValkeyValue;
  binary: boolean;
  truncated: boolean;
} & (
  | { parsed: true; messages: ParsedMessage[] }
  | { parsed: false; reason: string }
);

export interface PendingInterrupt {
  value?: JsonValue;
}

export interface SessionDetail {
  sessionId: string;
  preset: PresetId;
  keys: KeyView[];
  messages: ParsedMessage[];
  interrupts: PendingInterrupt[];
  estimatedTokens: number;
  ttlMs: number | null;
  memoryBytes: number;
  totalKeys: number;
  skippedKeys: number;
  totalMemoryBytes: number;
  unmeasuredKeys: number;
  selection: string | null;
  complete: boolean;
  unparsedKeys: number;
  truncated: boolean;
  failedNodes: number;
  missingKeys: number;
  touchesKeys: boolean;
}

export interface SessionOversizeResponse {
  thresholdBytes: number;
  sessionIds: string[];
  unmeasuredSessionIds: string[];
  truncated: boolean;
  partial: boolean;
  failedNodes: number;
}

export interface SessionPreview {
  sampleKey: string | null;
  view: KeyView | null;
  exhausted: boolean;
  failedNodes: number;
  touchesKeys: boolean;
}

export interface SessionExport {
  exportedAt: string;
  namespace: Pick<SessionNamespace, 'name' | 'pattern' | 'preset'>;
  sessionId: string;
  keys: CapturedKey[];
  parsed: SessionDetail;
}
