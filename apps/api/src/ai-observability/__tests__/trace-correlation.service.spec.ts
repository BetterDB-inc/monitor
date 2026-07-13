import { TraceCorrelationService } from '../trace-correlation.service';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { StoredOtelSpan } from '@betterdb/shared';

function span(o: Partial<StoredOtelSpan>): StoredOtelSpan {
  return {
    traceId: 't1',
    spanId: 's',
    parentSpanId: 'root',
    name: 'agent_cache.llm.check',
    scopeName: '@betterdb/agent-cache',
    serviceName: 'app',
    kind: 1,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    startTimeMs: 1,
    durationNs: 1,
    statusCode: 1,
    statusMessage: null,
    attributes: '{}',
    ingestedAt: 1,
    ...o,
  };
}

function makeSvc(spans: StoredOtelSpan[], call: (cmd: string, args: string[]) => unknown) {
  const storage = {
    getOtelTraceSpans: jest.fn(async () => spans),
  } as unknown as StoragePort;
  const client = {
    call: async (cmd: string, args: string[]) => call(cmd, args),
    getCapabilities: () => ({ hasVectorSearch: true }),
    getVectorIndexInfo: async () => ({ indexingState: 'ready' }),
  };
  const registry = { get: jest.fn(() => client) } as unknown as ConnectionRegistry;
  return new TraceCorrelationService(storage, registry);
}

describe('TraceCorrelationService.correlateTrace', () => {
  it('explains a cold miss whose key now exists', async () => {
    const svc = makeSvc(
      [span({ spanId: 'a', attributes: JSON.stringify({ 'cache.hit': false, 'cache.key': 'app:llm:abc' }) })],
      (cmd) => (cmd === 'EXISTS' ? 1 : cmd === 'TTL' ? 3600 : null),
    );

    const [c] = await svc.correlateTrace('t1', 'c1');

    expect(c.spanId).toBe('a');
    expect(c.instanceName).toBe('app');
    expect(c.reportedHit).toBe(false);
    expect(c.keyExistsNow).toBe(true);
    expect(c.keyTtlSeconds).toBe(3600);
    expect(c.explanation).toMatch(/populated after this request/);
  });

  it('explains a miss whose key is still absent', async () => {
    const svc = makeSvc(
      [span({ spanId: 'b', attributes: JSON.stringify({ 'cache.hit': false, 'cache.key': 'app:llm:x' }) })],
      (cmd) => (cmd === 'EXISTS' ? 0 : cmd === 'TTL' ? -2 : null),
    );
    const [c] = await svc.correlateTrace('t1', 'c1');
    expect(c.keyExistsNow).toBe(false);
    expect(c.explanation).toMatch(/Still uncached/);
  });

  it('reads threshold + index state for a semantic-cache span', async () => {
    const svc = makeSvc(
      [
        span({
          spanId: 'sc',
          scopeName: '@betterdb/semantic-cache',
          name: 'semantic_cache.check',
          attributes: JSON.stringify({ 'cache.hit': true, 'cache.matched_key': 'sc:entry:u1' }),
        }),
      ],
      (cmd, args) => {
        if (cmd === 'EXISTS') return 1;
        if (cmd === 'TTL') return -1;
        if (cmd === 'HGET' && args[0] === 'sc:__config' && args[1] === 'threshold') return '0.12';
        return null;
      },
    );

    const [c] = await svc.correlateTrace('t1', 'c1');
    expect(c.instanceName).toBe('sc');
    expect(c.threshold).toBeCloseTo(0.12);
    expect(c.indexState).toBe('ready');
    expect(c.explanation).toMatch(/Hit; key still present/);
  });

  it('correlates a keyless semantic miss via cache.name', async () => {
    const svc = makeSvc(
      [
        span({
          spanId: 'scmiss',
          scopeName: '@betterdb/semantic-cache',
          name: 'semantic_cache.check',
          attributes: JSON.stringify({ 'cache.hit': false, 'cache.name': 'sc' }), // miss: no key
        }),
      ],
      (cmd, args) => {
        if (cmd === 'HGET' && args[0] === 'sc:__config' && args[1] === 'threshold') return '0.12';
        return null; // EXISTS/TTL should never be called for a keyless span
      },
    );

    const [c] = await svc.correlateTrace('t1', 'c1');
    expect(c.instanceName).toBe('sc');
    expect(c.cacheKey).toBeNull();
    expect(c.keyExistsNow).toBeNull();
    expect(c.threshold).toBeCloseTo(0.12);
    expect(c.indexState).toBe('ready');
    expect(c.explanation).toMatch(/nothing matched/i);
  });

  it('skips spans without a cache key and non-betterdb spans', async () => {
    const svc = makeSvc(
      [
        span({ spanId: 'nokey', attributes: '{}' }),
        span({ spanId: 'foreign', scopeName: 'other', attributes: JSON.stringify({ 'cache.key': 'x:llm:y' }) }),
      ],
      () => 0,
    );
    const res = await svc.correlateTrace('t1', 'c1');
    expect(res).toHaveLength(0);
  });
});
