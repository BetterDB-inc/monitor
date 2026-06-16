import { describe, it, expect } from 'vitest';
import { AgentCache, MemoryStore, AgentMemory } from '../index';

describe('@betterdb/agent-memory exports', () => {
  it('re-exports AgentCache from @betterdb/agent-cache', () => {
    expect(typeof AgentCache).toBe('function');
  });

  it('exports the MemoryStore tier', () => {
    expect(typeof MemoryStore).toBe('function');
  });

  it('exports the AgentMemory facade', () => {
    expect(typeof AgentMemory).toBe('function');
  });
});
