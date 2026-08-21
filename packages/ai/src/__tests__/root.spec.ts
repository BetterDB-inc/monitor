import { describe, expect, it } from 'vitest';
import * as facade from '../index';

describe('@betterdb/ai root', () => {
  it('exports the primary classes flat', () => {
    expect(typeof facade.AgentCache).toBe('function');
    expect(typeof facade.SemanticCache).toBe('function');
    expect(typeof facade.MemoryStore).toBe('function');
    expect(typeof facade.AgentMemory).toBe('function');
    expect(typeof facade.Retriever).toBe('function');
  });

  it('exports non-conflicting helpers flat', () => {
    expect(typeof facade.escapeTag).toBe('function');
    expect(typeof facade.encodeFloat32).toBe('function');
    expect(typeof facade.createKeywordOverlapRerank).toBe('function');
    expect(typeof facade.compositeScore).toBe('function');
    expect(facade.TEXT_FIELD).toBeDefined();
  });

  it('exposes all five namespaces', () => {
    expect(facade.agentCache.AgentCache).toBe(facade.AgentCache);
    expect(facade.semanticCache.SemanticCache).toBe(facade.SemanticCache);
    expect(facade.retrieval.Retriever).toBe(facade.Retriever);
    expect(facade.memory.MemoryStore).toBe(facade.MemoryStore);
    expect(typeof facade.searchKit.encodeFloat32).toBe('function');
  });

  it('keeps both ValkeyCommandError classes distinct and reachable', () => {
    expect(facade.agentCache.ValkeyCommandError).not.toBe(facade.semanticCache.ValkeyCommandError);
    const err = new facade.semanticCache.ValkeyCommandError('GET', new Error('boom'));
    expect(err).toBeInstanceOf(facade.semanticCache.ValkeyCommandError);
    expect(err).not.toBeInstanceOf(facade.agentCache.ValkeyCommandError);
  });

  it('does not export conflicting names flat', () => {
    for (const name of ['ValkeyCommandError', 'DEFAULT_COST_TABLE', 'hashBytes', 'REGISTRY_KEY']) {
      expect(facade).not.toHaveProperty(name);
    }
  });
});
