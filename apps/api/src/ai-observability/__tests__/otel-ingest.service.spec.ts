import {
  DROPPED_ATTRIBUTES_KEY,
  OTEL_SPAN_LIMITS,
  OtelIngestService,
  OtlpTraceRequest,
} from '../otel-ingest.service';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { StoredOtelSpan } from '@betterdb/shared';

function makeService() {
  const saved: StoredOtelSpan[] = [];
  const storage = {
    saveOtelSpans: jest.fn(async (spans: StoredOtelSpan[]) => {
      saved.push(...spans);
      return spans.length;
    }),
  } as unknown as StoragePort;
  return { svc: new OtelIngestService(storage), saved };
}

const NOW = 1_700_000_000_100;

function req(): OtlpTraceRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'chat-app' } }] },
        scopeSpans: [
          {
            scope: { name: 'chat-app-instrumentation' },
            spans: [
              // root, non-betterdb scope → kept (root)
              {
                traceId: 't1',
                spanId: 'root',
                name: 'chat.turn',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000000742000000',
              },
              // non-betterdb, non-root → dropped
              {
                traceId: 't1',
                spanId: 'fetch',
                parentSpanId: 'root',
                name: 'fetch POST',
                startTimeUnixNano: '1700000000100000000',
                endTimeUnixNano: '1700000000200000000',
              },
            ],
          },
          {
            scope: { name: '@betterdb/agent-cache' },
            spans: [
              // betterdb child → kept, with attributes flattened
              {
                traceId: 't1',
                spanId: 'cache',
                parentSpanId: 'root',
                name: 'agent_cache.llm.check',
                startTimeUnixNano: '1700000000010000000',
                endTimeUnixNano: '1700000000011000000',
                attributes: [
                  { key: 'cache.hit', value: { boolValue: true } },
                  { key: 'cache.model', value: { stringValue: 'gpt-4o-mini' } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('OtelIngestService.ingest', () => {
  it('keeps @betterdb/* spans plus roots, drops other spans', async () => {
    const { svc, saved } = makeService();

    const res = await svc.ingest(req(), NOW);

    expect(res.received).toBe(3);
    expect(res.stored).toBe(2);
    expect(saved.map((s) => s.spanId).sort()).toEqual(['cache', 'root']);
    expect(saved.find((s) => s.spanId === 'fetch')).toBeUndefined();
  });

  it('maps times, service, scope, and attributes', async () => {
    const { svc, saved } = makeService();
    await svc.ingest(req(), NOW);

    const root = saved.find((s) => s.spanId === 'root')!;
    expect(root.serviceName).toBe('chat-app');
    expect(root.parentSpanId).toBeNull();
    expect(root.startTimeMs).toBe(1_700_000_000_000);
    expect(root.durationNs).toBe(742_000_000);
    expect(root.ingestedAt).toBe(NOW);

    const cache = saved.find((s) => s.spanId === 'cache')!;
    expect(cache.scopeName).toBe('@betterdb/agent-cache');
    expect(cache.durationNs).toBe(1_000_000);
    const attrs = JSON.parse(cache.attributes);
    expect(attrs['cache.hit']).toBe(true);
    expect(attrs['cache.model']).toBe('gpt-4o-mini');
  });

  it('treats an all-zero parentSpanId as a root (does not drop it)', async () => {
    const { svc, saved } = makeService();
    const req: OtlpTraceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: 'chat-app' }, // non-betterdb: only kept if recognized as root
              spans: [
                {
                  traceId: 't9',
                  spanId: 'root9',
                  parentSpanId: '0000000000000000', // all-zero → root
                  name: 'chat.turn',
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000500000000',
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await svc.ingest(req, NOW);

    expect(res.stored).toBe(1);
    expect(saved[0].spanId).toBe('root9');
    expect(saved[0].parentSpanId).toBeNull();
  });

  it('stores nothing for an empty request', async () => {
    const { svc, saved } = makeService();
    const res = await svc.ingest({}, NOW);
    expect(res).toEqual({ stored: 0, received: 0 });
    expect(saved).toHaveLength(0);
  });

  it('clamps a far-future sender start time to receive time + skew (GHSA-3pjj)', async () => {
    // startTimeMs drives sorting and time-window queries; an unclamped
    // far-future value would pin hostile spans to the top of every listing.
    const { svc, saved } = makeService();
    const farFutureNano = `${(NOW + 10 * 365 * 24 * 60 * 60 * 1000)}000000`; // ~10y ahead
    const req: OtlpTraceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: '@betterdb/agent-cache' },
              spans: [
                {
                  traceId: 'tf',
                  spanId: 'future',
                  name: 'agent_cache.llm.check',
                  startTimeUnixNano: farFutureNano,
                  endTimeUnixNano: farFutureNano,
                },
              ],
            },
          ],
        },
      ],
    };

    await svc.ingest(req, NOW);

    expect(saved).toHaveLength(1);
    const fiveMinutes = 5 * 60 * 1000;
    expect(saved[0].startTimeMs).toBe(NOW + fiveMinutes); // clamped, not sender time
    expect(saved[0].ingestedAt).toBe(NOW); // retention key is server-stamped
    // The raw nano fields keep what the sender sent, for span detail display.
    expect(saved[0].startTimeUnixNano).toBe(farFutureNano);
  });

  it('keeps an honest in-skew start time untouched', async () => {
    const { svc, saved } = makeService();
    await svc.ingest(req(), NOW);
    const root = saved.find((s) => s.spanId === 'root')!;
    expect(root.startTimeMs).toBe(1_700_000_000_000); // NOW - 100ms: within skew
  });

  describe('per-span size limits (GHSA-3pjj)', () => {
    // One root span, in a @betterdb scope, with the given overrides.
    function oneSpan(
      span: Record<string, unknown>,
      opts: { serviceName?: string; scopeName?: string } = {},
    ): OtlpTraceRequest {
      return {
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: 'service.name', value: { stringValue: opts.serviceName ?? 'svc' } },
              ],
            },
            scopeSpans: [
              {
                scope: { name: opts.scopeName ?? '@betterdb/agent-cache' },
                spans: [
                  {
                    traceId: 't1',
                    spanId: 's1',
                    name: 'agent_cache.llm.check',
                    startTimeUnixNano: '1700000000000000000',
                    endTimeUnixNano: '1700000000001000000',
                    ...span,
                  } as never,
                ],
              },
            ],
          },
        ],
      };
    }

    it('bounds a span carrying ~1MB of compressible attributes to a few KB', async () => {
      // The reviewer's repro: one root span per request with ~1MB of repetitive
      // attributes gzips to ~1KB, and was previously stored whole.
      const { svc, saved } = makeService();
      const big = 'x'.repeat(64 * 1024);
      const attributes = Array.from({ length: 16 }, (_, i) => ({
        key: `attr.${i}`,
        value: { stringValue: big },
      }));
      await svc.ingest(
        oneSpan(
          { attributes, name: big, status: { code: 2, message: big } },
          { serviceName: big, scopeName: `@betterdb/${big}` },
        ),
        NOW,
      );

      expect(saved).toHaveLength(1);
      const s = saved[0];
      expect(s.attributes.length).toBeLessThanOrEqual(OTEL_SPAN_LIMITS.maxAttributesJsonLength + 64);
      expect(s.name).toHaveLength(OTEL_SPAN_LIMITS.maxNameLength);
      expect(s.statusMessage).toHaveLength(OTEL_SPAN_LIMITS.maxStatusMessageLength);
      expect(s.serviceName).toHaveLength(OTEL_SPAN_LIMITS.maxScopeOrServiceNameLength);
      expect(s.scopeName).toHaveLength(OTEL_SPAN_LIMITS.maxScopeOrServiceNameLength);
      expect(s.scopeName.startsWith('@betterdb/')).toBe(true); // still recognised as betterdb
      expect(JSON.stringify(s).length).toBeLessThan(8 * 1024);
    });

    it('truncates long string values and records how many attributes were dropped', async () => {
      const { svc, saved } = makeService();
      const attributes = [
        { key: 'cache.hit', value: { boolValue: true } },
        { key: 'cache.key', value: { stringValue: 'k'.repeat(5000) } },
        ...Array.from({ length: 100 }, (_, i) => ({ key: `n.${i}`, value: { intValue: i } })),
      ];
      await svc.ingest(oneSpan({ attributes }), NOW);

      const attrs = JSON.parse(saved[0].attributes) as Record<string, unknown>;
      expect(attrs['cache.hit']).toBe(true);
      expect(attrs['cache.key']).toHaveLength(OTEL_SPAN_LIMITS.maxAttributeValueLength);
      const kept = Object.keys(attrs).filter((k) => k !== DROPPED_ATTRIBUTES_KEY);
      expect(kept.length).toBeLessThanOrEqual(OTEL_SPAN_LIMITS.maxAttributes);
      expect(attrs[DROPPED_ATTRIBUTES_KEY]).toBe(102 - kept.length);
    });

    it('measures the budget on serialized JSON, so escape-heavy values cannot inflate it', async () => {
      const { svc, saved } = makeService();
      // Each control char serializes as a 6-char \u escape.
      const nasty = '\u0001'.repeat(OTEL_SPAN_LIMITS.maxAttributeValueLength);
      const attributes = Array.from({ length: 20 }, (_, i) => ({
        key: `e.${i}`,
        value: { stringValue: nasty },
      }));
      await svc.ingest(oneSpan({ attributes }), NOW);
      expect(saved[0].attributes.length).toBeLessThanOrEqual(
        OTEL_SPAN_LIMITS.maxAttributesJsonLength + 64,
      );
    });

    it('stores an oversized array / kvlist value as clipped JSON text', async () => {
      const { svc, saved } = makeService();
      const values = Array.from({ length: 2000 }, (_, i) => ({ stringValue: `v${i}` }));
      await svc.ingest(
        oneSpan({
          attributes: [
            { key: 'small', value: { arrayValue: { values: [{ stringValue: 'a' }] } } },
            { key: 'large', value: { arrayValue: { values } } },
          ],
        }),
        NOW,
      );
      const attrs = JSON.parse(saved[0].attributes) as Record<string, unknown>;
      expect(attrs.small).toEqual({ values: [{ stringValue: 'a' }] });
      expect(typeof attrs.large).toBe('string');
      expect(attrs.large).toHaveLength(OTEL_SPAN_LIMITS.maxAttributeValueLength);
    });

    it('drops a span whose ids exceed the id length limit instead of truncating them', async () => {
      const { svc, saved } = makeService();
      const longId = 'a'.repeat(OTEL_SPAN_LIMITS.maxIdLength + 1);
      await svc.ingest(oneSpan({ traceId: longId }), NOW);
      await svc.ingest(oneSpan({ spanId: longId }), NOW);
      await svc.ingest(oneSpan({ parentSpanId: longId }), NOW);
      expect(saved).toHaveLength(0);
    });

    it('zeroes start/end nano strings that are not valid uint64 values', async () => {
      const { svc, saved } = makeService();
      await svc.ingest(
        oneSpan({ startTimeUnixNano: '9'.repeat(10_000), endTimeUnixNano: '-5' }),
        NOW,
      );
      expect(saved).toHaveLength(1);
      expect(saved[0].startTimeUnixNano).toBe('0');
      expect(saved[0].endTimeUnixNano).toBe('0');
    });

    it('clamps durationNs to a value the BIGINT column can hold', async () => {
      const { svc, saved } = makeService();
      await svc.ingest(
        oneSpan({ startTimeUnixNano: '1', endTimeUnixNano: '18446744073709551615' }),
        NOW,
      );
      expect(saved[0].durationNs).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('zeroes kind and status code unless they are int32 integers', async () => {
      const { svc, saved } = makeService();
      await svc.ingest(oneSpan({ kind: 1e12, status: { code: 1.5 } }), NOW);
      await svc.ingest(oneSpan({ kind: '2', status: { code: -(2 ** 31) - 1 } }), NOW);
      await svc.ingest(oneSpan({ kind: 2, status: { code: 1 } }), NOW);
      expect(saved.map((s) => [s.kind, s.statusCode])).toEqual([
        [0, 0],
        [0, 0],
        [2, 1],
      ]);
    });

    it('cannot skip the attribute count with a __proto__ key', async () => {
      const { svc, saved } = makeService();
      // Before the null-prototype fix, this value became the prototype, so
      // `key in out` was true for every a.N and none of them were counted.
      const names = Array.from({ length: 70 }, (_, i) => `a${i}`);
      const attributes = [
        { key: '__proto__', value: { kvlistValue: Object.fromEntries(names.map((n) => [n, 1])) } },
        ...names.map((key) => ({ key, value: { intValue: 1 } })),
      ];
      await svc.ingest(oneSpan({ attributes }), NOW);

      const attrs = JSON.parse(saved[0].attributes) as Record<string, unknown>;
      const kept = Object.keys(attrs).filter((k) => k !== DROPPED_ATTRIBUTES_KEY);
      expect(kept).toHaveLength(OTEL_SPAN_LIMITS.maxAttributes);
      expect(attrs[DROPPED_ATTRIBUTES_KEY]).toBe(71 - OTEL_SPAN_LIMITS.maxAttributes);
    });

    it('ignores a sender-supplied dropped-attributes count', async () => {
      const { svc, saved } = makeService();
      await svc.ingest(
        oneSpan({
          attributes: [
            { key: DROPPED_ATTRIBUTES_KEY, value: { intValue: 999 } },
            { key: 'cache.hit', value: { boolValue: true } },
          ],
        }),
        NOW,
      );
      expect(JSON.parse(saved[0].attributes)).toEqual({ 'cache.hit': true });
    });
  });
});
