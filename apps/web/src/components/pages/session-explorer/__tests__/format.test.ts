import { describe, it, expect } from 'vitest';
import type { SessionNamespace } from '@betterdb/shared';
import { displaySessionId, sessionIdPrefix } from '../format';

const ns = (overrides: Partial<SessionNamespace> = {}) => ({
  pattern: 'message_store:*',
  preset: 'langchain-community' as const,
  customSchema: null,
  ...overrides,
});

describe('sessionIdPrefix', () => {
  it('is the literal part of the pattern before the first wildcard', () => {
    expect(sessionIdPrefix(ns())).toBe('message_store:');
  });

  it('unescapes escaped glob characters', () => {
    expect(sessionIdPrefix(ns({ pattern: 'tenant\\[1\\]:*' }))).toBe('tenant[1]:');
  });

  it('is empty for agent-cache, whose session id is not the key', () => {
    expect(sessionIdPrefix(ns({ preset: 'agent-cache', pattern: 'ac:*' }))).toBe('');
  });

  it('is empty for a custom schema with a session template', () => {
    expect(
      sessionIdPrefix(
        ns({
          preset: 'custom',
          pattern: 'app:*',
          customSchema: {
            sessionTemplate: 'app:{session}:msgs',
            valueType: 'list',
            messages: { from: 'items' },
            fields: { role: 'role', content: 'content' },
          },
        }),
      ),
    ).toBe('');
  });

  it('keeps the prefix for a custom schema without a session template', () => {
    expect(
      sessionIdPrefix(
        ns({
          preset: 'custom',
          pattern: 'app:*',
          customSchema: {
            valueType: 'list',
            messages: { from: 'items' },
            fields: { role: 'role', content: 'content' },
          },
        }),
      ),
    ).toBe('app:');
  });
});

describe('displaySessionId', () => {
  it('strips the prefix', () => {
    expect(displaySessionId('tenant[1]:abc', 'tenant[1]:')).toBe('abc');
  });

  it('keeps ids that do not start with the prefix', () => {
    expect(displaySessionId('other:abc', 'tenant:')).toBe('other:abc');
  });

  it('keeps an id that is the prefix itself', () => {
    expect(displaySessionId('tenant:', 'tenant:')).toBe('tenant:');
  });

  it('keeps the id when there is no prefix', () => {
    expect(displaySessionId('abc', '')).toBe('abc');
  });
});
