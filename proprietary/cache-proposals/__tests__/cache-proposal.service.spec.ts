import { MemoryAdapter } from '@app/storage/adapters/memory.adapter';
import { CacheProposalService } from '../cache-proposal.service';
import { CacheResolverService, type ResolvedCache } from '../cache-resolver.service';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import {
  CacheNotFoundError,
  CacheProposalValidationError,
  DuplicatePendingProposalError,
  InvalidCacheTypeError,
  RateLimitedError,
} from '../errors';

const CONNECTION_ID = 'conn-test';
const SEMANTIC_CACHE = 'sc:prod';
const AGENT_CACHE = 'ac:prod';
const VALID_REASON = 'tightening based on observed false-positive rate above 6%';

class StubResolver {
  private readonly entries = new Map<string, ResolvedCache>();

  set(name: string, type: ResolvedCache['type'], connectionId: string = CONNECTION_ID): void {
    this.entries.set(`${connectionId}:${name}`, {
      name,
      type,
      prefix: name,
      capabilities: [],
      protocol_version: 1,
      live: true,
    });
  }

  async resolveCacheByName(connectionId: string, name: string): Promise<ResolvedCache | null> {
    return this.entries.get(`${connectionId}:${name}`) ?? null;
  }

  invalidate(): void {
    this.entries.clear();
  }
}

const buildService = (): { service: CacheProposalService; storage: MemoryAdapter; resolver: StubResolver } => {
  const storage = new MemoryAdapter();
  const resolver = new StubResolver();
  resolver.set(SEMANTIC_CACHE, 'semantic_cache');
  resolver.set(AGENT_CACHE, 'agent_cache');
  const service = new CacheProposalService(storage, resolver as unknown as CacheResolverService);
  return { service, storage, resolver };
};

/**
 * Build a service with a fake Valkey registry so readCurrentThreshold / readCurrentTtl
 * can retrieve values the dispatcher would have previously written.
 */
function buildServiceWithRegistry(
  configStore: Record<string, string>,
  policiesStore: Record<string, string>,
): { service: CacheProposalService; resolver: StubResolver } {
  const storage = new MemoryAdapter();
  const resolver = new StubResolver();
  resolver.set(SEMANTIC_CACHE, 'semantic_cache');
  resolver.set(AGENT_CACHE, 'agent_cache');

  const fakeClient = {
    hgetall: async (key: string) => {
      if (key.endsWith(':__config')) return { ...configStore };
      return {};
    },
    hget: async (key: string, field: string) => {
      if (key.endsWith(':__tool_policies')) return policiesStore[field] ?? null;
      return null;
    },
    get: async () => null,
  };
  const fakeRegistry = {
    get: () => ({ getClient: () => fakeClient }),
  } as unknown as ConnectionRegistry;

  const service = new CacheProposalService(
    storage,
    resolver as unknown as CacheResolverService,
    undefined,   // applyService
    fakeRegistry,
  );
  return { service, resolver };
}

describe('CacheProposalService', () => {
  describe('proposeThresholdAdjust', () => {
    it('accepts new_threshold = 0 (boundary)', async () => {
      const { service } = buildService();
      const result = await service.proposeThresholdAdjust(CONNECTION_ID, {
        cacheName: SEMANTIC_CACHE,
        newThreshold: 0,
        reasoning: VALID_REASON,
      });
      expect(result.proposal.status).toBe('pending');
      if (result.proposal.proposal_type === 'threshold_adjust') {
        expect(result.proposal.proposal_payload.new_threshold).toBe(0);
      }
    });

    it('accepts new_threshold = 2 (boundary)', async () => {
      const { service } = buildService();
      const result = await service.proposeThresholdAdjust(CONNECTION_ID, {
        cacheName: SEMANTIC_CACHE,
        newThreshold: 2,
        reasoning: VALID_REASON,
      });
      expect(result.proposal.status).toBe('pending');
    });

    it('rejects new_threshold = -0.01', async () => {
      const { service } = buildService();
      await expect(
        service.proposeThresholdAdjust(CONNECTION_ID, {
          cacheName: SEMANTIC_CACHE,
          newThreshold: -0.01,
          reasoning: VALID_REASON,
        }),
      ).rejects.toThrow();
    });

    it('rejects new_threshold = 2.01', async () => {
      const { service } = buildService();
      await expect(
        service.proposeThresholdAdjust(CONNECTION_ID, {
          cacheName: SEMANTIC_CACHE,
          newThreshold: 2.01,
          reasoning: VALID_REASON,
        }),
      ).rejects.toThrow();
    });

    it('rejects reasoning shorter than 20 chars', async () => {
      const { service } = buildService();
      await expect(
        service.proposeThresholdAdjust(CONNECTION_ID, {
          cacheName: SEMANTIC_CACHE,
          newThreshold: 0.1,
          reasoning: 'too short',
        }),
      ).rejects.toBeInstanceOf(CacheProposalValidationError);
    });

    it('rejects when called on agent_cache', async () => {
      const { service } = buildService();
      await expect(
        service.proposeThresholdAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          newThreshold: 0.1,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(InvalidCacheTypeError);
    });

    it('rejects duplicate pending proposal for same (cache_name, category)', async () => {
      const { service } = buildService();
      await service.proposeThresholdAdjust(CONNECTION_ID, {
        cacheName: SEMANTIC_CACHE,
        category: 'faq',
        newThreshold: 0.1,
        reasoning: VALID_REASON,
      });
      await expect(
        service.proposeThresholdAdjust(CONNECTION_ID, {
          cacheName: SEMANTIC_CACHE,
          category: 'faq',
          newThreshold: 0.08,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(DuplicatePendingProposalError);
    });

    it('allows duplicate for different category', async () => {
      const { service } = buildService();
      await service.proposeThresholdAdjust(CONNECTION_ID, {
        cacheName: SEMANTIC_CACHE,
        category: 'faq',
        newThreshold: 0.1,
        reasoning: VALID_REASON,
      });
      const result = await service.proposeThresholdAdjust(CONNECTION_ID, {
        cacheName: SEMANTIC_CACHE,
        category: 'support',
        newThreshold: 0.1,
        reasoning: VALID_REASON,
      });
      expect(result.proposal.status).toBe('pending');
    });

    it('rejects when cache is not registered in discovery markers', async () => {
      const { service } = buildService();
      await expect(
        service.proposeThresholdAdjust(CONNECTION_ID, {
          cacheName: 'unknown:cache',
          newThreshold: 0.1,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(CacheNotFoundError);
    });
  });

  describe('proposeToolTtlAdjust', () => {
    it('accepts new_ttl_seconds = 10 and 86400 (boundaries)', async () => {
      const { service } = buildService();
      const a = await service.proposeToolTtlAdjust(CONNECTION_ID, {
        cacheName: AGENT_CACHE,
        toolName: 'tool-a',
        newTtlSeconds: 10,
        reasoning: VALID_REASON,
      });
      const b = await service.proposeToolTtlAdjust(CONNECTION_ID, {
        cacheName: AGENT_CACHE,
        toolName: 'tool-b',
        newTtlSeconds: 86400,
        reasoning: VALID_REASON,
      });
      expect(a.proposal.status).toBe('pending');
      expect(b.proposal.status).toBe('pending');
    });

    it('rejects new_ttl_seconds = 9', async () => {
      const { service } = buildService();
      await expect(
        service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: 'search',
          newTtlSeconds: 9,
          reasoning: VALID_REASON,
        }),
      ).rejects.toThrow();
    });

    it('rejects new_ttl_seconds = 86401', async () => {
      const { service } = buildService();
      await expect(
        service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: 'search',
          newTtlSeconds: 86401,
          reasoning: VALID_REASON,
        }),
      ).rejects.toThrow();
    });

    it('rejects when called on semantic_cache', async () => {
      const { service } = buildService();
      await expect(
        service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: SEMANTIC_CACHE,
          toolName: 'search',
          newTtlSeconds: 300,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(InvalidCacheTypeError);
    });

    it('rejects duplicate pending for same (cache_name, tool_name)', async () => {
      const { service } = buildService();
      await service.proposeToolTtlAdjust(CONNECTION_ID, {
        cacheName: AGENT_CACHE,
        toolName: 'search',
        newTtlSeconds: 600,
        reasoning: VALID_REASON,
      });
      await expect(
        service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: 'search',
          newTtlSeconds: 1200,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(DuplicatePendingProposalError);
    });
  });

  describe('proposeInvalidate', () => {
    it('rejects non-valkey_search filter_kind on semantic_cache', async () => {
      const { service } = buildService();
      await expect(
        service.proposeInvalidate(CONNECTION_ID, {
          cacheName: SEMANTIC_CACHE,
          filterKind: 'tool',
          filterValue: 'search',
          estimatedAffected: 10,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(CacheProposalValidationError);
    });

    it('rejects valkey_search filter_kind on agent_cache', async () => {
      const { service } = buildService();
      await expect(
        service.proposeInvalidate(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          filterKind: 'valkey_search',
          filterExpression: '@model:{x}',
          estimatedAffected: 10,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(CacheProposalValidationError);
    });

    it('warns but does not reject when estimated_affected > 10000', async () => {
      const { service } = buildService();
      const result = await service.proposeInvalidate(CONNECTION_ID, {
        cacheName: SEMANTIC_CACHE,
        filterKind: 'valkey_search',
        filterExpression: '@model:{x}',
        estimatedAffected: 12000,
        reasoning: VALID_REASON,
      });
      expect(result.proposal.status).toBe('pending');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('12000');
    });

    it('does not warn when estimated_affected <= 10000', async () => {
      const { service } = buildService();
      const result = await service.proposeInvalidate(CONNECTION_ID, {
        cacheName: SEMANTIC_CACHE,
        filterKind: 'valkey_search',
        filterExpression: '@model:{x}',
        estimatedAffected: 10_000,
        reasoning: VALID_REASON,
      });
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('rate limiting', () => {
    it('rejects the 31st proposal within the same hour for the same connection', async () => {
      const { service } = buildService();
      for (let i = 0; i < 30; i++) {
        await service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: `tool-${i}`,
          newTtlSeconds: 60,
          reasoning: VALID_REASON,
        });
      }
      await expect(
        service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: 'tool-31',
          newTtlSeconds: 60,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(RateLimitedError);
    });

    it('maps a unique-constraint violation to DuplicatePendingProposalError', async () => {
      const { service, storage } = buildService();
      storage.createCacheProposal = async () => {
        throw Object.assign(new Error('SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed'), {
          code: 'SQLITE_CONSTRAINT_UNIQUE',
        });
      };
      await expect(
        service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: 'tool-x',
          newTtlSeconds: 60,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(DuplicatePendingProposalError);
    });

    it('does not treat a CHECK constraint failure as a duplicate', async () => {
      const { service, storage } = buildService();
      const checkError = Object.assign(
        new Error('SQLITE_CONSTRAINT_CHECK: CHECK constraint failed'),
        { code: 'SQLITE_CONSTRAINT_CHECK' },
      );
      storage.createCacheProposal = async () => {
        throw checkError;
      };
      await expect(
        service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: 'tool-x',
          newTtlSeconds: 60,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBe(checkError);
    });

    it('releases the rate-limit slot when storage write fails', async () => {
      const { service, storage } = buildService();
      const original = storage.createCacheProposal.bind(storage);
      let callCount = 0;
      storage.createCacheProposal = async (input) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('simulated storage failure');
        }
        return original(input);
      };

      await expect(
        service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: 'tool-1',
          newTtlSeconds: 60,
          reasoning: VALID_REASON,
        }),
      ).rejects.toThrow('simulated storage failure');

      for (let i = 0; i < 30; i++) {
        await service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: `retry-${i}`,
          newTtlSeconds: 60,
          reasoning: VALID_REASON,
        });
      }
    });

    it('does not count proposals against other connections', async () => {
      const { service, resolver } = buildService();
      const OTHER_CONNECTION_ID = 'conn-other';
      resolver.set(AGENT_CACHE, 'agent_cache', OTHER_CONNECTION_ID);

      for (let i = 0; i < 30; i++) {
        await service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: `tool-${i}`,
          newTtlSeconds: 60,
          reasoning: VALID_REASON,
        });
      }
      await expect(
        service.proposeToolTtlAdjust(CONNECTION_ID, {
          cacheName: AGENT_CACHE,
          toolName: 'overflow',
          newTtlSeconds: 60,
          reasoning: VALID_REASON,
        }),
      ).rejects.toBeInstanceOf(RateLimitedError);

      const result = await service.proposeToolTtlAdjust(OTHER_CONNECTION_ID, {
        cacheName: AGENT_CACHE,
        toolName: 'fresh-tool',
        newTtlSeconds: 60,
        reasoning: VALID_REASON,
      });
      expect(result.proposal.status).toBe('pending');
      expect(result.proposal.connection_id).toBe(OTHER_CONNECTION_ID);
    });
  });
});

describe('CacheProposalService — readCurrentThreshold reads dispatcher-written values', () => {
  // These tests verify the full apply→re-propose cycle:
  // after CacheApplyDispatcher writes a new threshold to {prefix}:__config,
  // the next proposal's current_threshold should reflect that applied value,
  // not the SDK-published baseline.

  it('proposeThresholdAdjust uses the threshold field from __config as current_threshold', async () => {
    // Dispatcher writes: client.hset(`${prefix}:__config`, 'threshold', '0.5')
    const { service } = buildServiceWithRegistry({ threshold: '0.5' }, {});
    const result = await service.proposeThresholdAdjust(CONNECTION_ID, {
      cacheName: SEMANTIC_CACHE,
      newThreshold: 0.3,
      reasoning: VALID_REASON,
    });
    if (result.proposal.proposal_type !== 'threshold_adjust') throw new Error('wrong type');
    expect(result.proposal.proposal_payload.current_threshold).toBe(0.5);
  });

  it('proposeThresholdAdjust uses threshold:{category} field for per-category proposals', async () => {
    // Dispatcher writes: client.hset(`${prefix}:__config`, 'threshold:faq', '0.07')
    const { service } = buildServiceWithRegistry({ 'threshold:faq': '0.07' }, {});
    const result = await service.proposeThresholdAdjust(CONNECTION_ID, {
      cacheName: SEMANTIC_CACHE,
      category: 'faq',
      newThreshold: 0.05,
      reasoning: VALID_REASON,
    });
    if (result.proposal.proposal_type !== 'threshold_adjust') throw new Error('wrong type');
    expect(result.proposal.proposal_payload.current_threshold).toBe(0.07);
  });

  it('falls back to 0 when __config has no threshold field yet', async () => {
    const { service } = buildServiceWithRegistry({}, {});
    const result = await service.proposeThresholdAdjust(CONNECTION_ID, {
      cacheName: SEMANTIC_CACHE,
      newThreshold: 0.1,
      reasoning: VALID_REASON,
    });
    if (result.proposal.proposal_type !== 'threshold_adjust') throw new Error('wrong type');
    expect(result.proposal.proposal_payload.current_threshold).toBe(0);
  });

  it('proposeToolTtlAdjust uses the TTL from __tool_policies as current_ttl_seconds', async () => {
    // Dispatcher writes: client.hset(`${prefix}:__tool_policies`, 'search', JSON.stringify({ ttl: 600 }))
    const { service } = buildServiceWithRegistry(
      {},
      { search: JSON.stringify({ ttl: 600 }) },
    );
    const result = await service.proposeToolTtlAdjust(CONNECTION_ID, {
      cacheName: AGENT_CACHE,
      toolName: 'search',
      newTtlSeconds: 300,
      reasoning: VALID_REASON,
    });
    if (result.proposal.proposal_type !== 'tool_ttl_adjust') throw new Error('wrong type');
    expect(result.proposal.proposal_payload.current_ttl_seconds).toBe(600);
  });
});
