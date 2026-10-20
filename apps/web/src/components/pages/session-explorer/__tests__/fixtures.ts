import type { KeyView, SessionDetail, SessionListResponse } from '@betterdb/shared';

export const listResponse = (overrides: Partial<SessionListResponse> = {}): SessionListResponse => ({
  sessions: [
    { sessionId: 'alpha', keyCount: 1, memoryBytes: 300, idleSeconds: 50, ttlMs: 9000 },
    { sessionId: 'bravo', keyCount: 2, memoryBytes: 900, idleSeconds: 5, ttlMs: null },
    { sessionId: 'charlie', keyCount: 1, memoryBytes: 100, idleSeconds: 500, ttlMs: 1000 },
  ],
  scannedKeys: 4,
  truncated: false,
  partial: false,
  failedNodes: 0,
  ...overrides,
});

export const parsedKey = (overrides: Partial<KeyView> = {}): KeyView =>
  ({
    key: 'chat:1',
    type: 'list',
    ttlMs: 5000,
    raw: ['{"type":"human"}'],
    truncated: false,
    parsed: true,
    messages: [
      { role: 'human', content: 'Where should I stay?' },
      { role: 'ai', content: 'Alfama for atmosphere.' },
    ],
    ...overrides,
  }) as KeyView;

export const failedKey = (overrides: Partial<KeyView> = {}): KeyView =>
  ({
    key: 'chat:2',
    type: 'string',
    ttlMs: null,
    raw: 'not a message',
    truncated: false,
    parsed: false,
    reason: 'Element is not a {type, data} message envelope',
    ...overrides,
  }) as KeyView;

export const detail = (overrides: Partial<SessionDetail> = {}): SessionDetail => ({
  sessionId: 'chat:1',
  preset: 'langchain-community',
  keys: [parsedKey()],
  messages: [
    { role: 'human', content: 'What is the weather in Sofia?' },
    {
      role: 'ai',
      content: '',
      toolCalls: [{ name: 'get_weather', args: { city: 'Sofia' }, id: 'call-1' }],
    },
    {
      role: 'tool',
      content: '{"temp":21}',
      toolResult: { name: 'get_weather', content: '{"temp":21}' },
    },
  ],
  estimatedTokens: 42,
  ttlMs: 5000,
  memoryBytes: 2048,
  complete: true,
  unparsedKeys: 0,
  truncated: false,
  failedNodes: 0,
  missingKeys: 0,
  ...overrides,
});
