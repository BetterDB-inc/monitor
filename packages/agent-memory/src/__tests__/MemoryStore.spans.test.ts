import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { MemoryStore } from '../MemoryStore';
import { fakeEmbed } from './helpers/fakeEmbed';
import { mockClient } from './helpers/mockClient';

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;

beforeAll(() => {
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

function spanNamed(name: string) {
  return exporter.getFinishedSpans().find((s) => s.name === name);
}

function recallHit(distance: number): unknown[] {
  const now = Date.now();
  const fields: Record<string, string> = {
    __score: String(distance),
    content: 'c',
    importance: '0.5',
    created_at: String(now),
    last_accessed_at: String(now),
    access_count: '0',
  };
  const flat: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    flat.push(field, value);
  }
  return ['1', 'mem:mem:a', flat];
}

function consolidateHit(id: string): [string, string[]] {
  const created = Date.now() - 100000 * 1000;
  const fields: Record<string, string> = {
    content: `c-${id}`,
    importance: '0.2',
    created_at: String(created),
    last_accessed_at: String(created),
    access_count: '0',
  };
  const flat: string[] = [];
  for (const [f, v] of Object.entries(fields)) {
    flat.push(f, v);
  }
  return [`mem:mem:${id}`, flat];
}

function searchReply(total: number, hits: Array<[string, string[]]> = []): unknown[] {
  const out: unknown[] = [String(total)];
  for (const [key, flat] of hits) {
    out.push(key, flat);
  }
  return out;
}

describe('MemoryStore spans', () => {
  it('emits a remember span with the importance attribute', async () => {
    const store = new MemoryStore({
      client: mockClient(() => 'OK'),
      name: 'mem',
      embedFn: fakeEmbed(8),
    });

    await store.remember('hi', { importance: 0.8 });

    const span = spanNamed('agent_memory.remember');
    expect(span).toBeDefined();
    expect(span?.attributes['memory.importance']).toBe(0.8);
  });

  it('emits a recall span with k and result count', async () => {
    const client = mockClient((command) => (command === 'FT.SEARCH' ? recallHit(0.1) : 'OK'));
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.recall('q', { k: 1 });

    const span = spanNamed('agent_memory.recall');
    expect(span).toBeDefined();
    expect(span?.attributes['recall.k']).toBe(1);
    expect(span?.attributes['recall.result_count']).toBe(1);
  });

  it('emits a consolidate span with candidate/created/deleted counts', async () => {
    const client = mockClient((command, ...args) => {
      if (command === 'FT.SEARCH') {
        return searchReply(1, [consolidateHit('a')]);
      }
      if (command === 'DEL') {
        return args.length;
      }
      return 'OK';
    });
    const store = new MemoryStore({ client, name: 'mem', embedFn: fakeEmbed(8) });

    await store.consolidate({ namespace: 'u1', summarize: vi.fn(async () => 'summary') });

    const span = spanNamed('agent_memory.consolidate');
    expect(span).toBeDefined();
    expect(span?.attributes['consolidate.candidates']).toBe(1);
    expect(span?.attributes['consolidate.created']).toBe(1);
    expect(span?.attributes['consolidate.deleted']).toBe(1);
  });
});
