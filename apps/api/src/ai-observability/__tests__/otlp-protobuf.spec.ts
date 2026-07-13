import * as protobuf from 'protobufjs';
import { decodeOtlpTraceProtobuf } from '../otlp-protobuf';
import { OtelIngestService } from '../otel-ingest.service';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';

// Same field numbers as the decoder — round-tripping validates them.
const ENCODE_PROTO = `
syntax = "proto3";
package opentelemetry.proto.collector.trace.v1;
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message Resource { repeated KeyValue attributes = 1; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; }
message InstrumentationScope { string name = 1; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4; string name = 5;
  uint32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9; Status status = 15;
}
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; } }
message Status { string message = 2; uint32 code = 3; }
`;

const Req = protobuf
  .parse(ENCODE_PROTO)
  .root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');

const TRACE_HEX = '0af7651916cd43dd8448eb211c80319c';
const SPAN_HEX = 'b7ad6b7169203331';

function encode(): Buffer {
  const msg = Req.fromObject({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeSpans: [
          {
            scope: { name: '@betterdb/agent-cache' },
            spans: [
              {
                traceId: Buffer.from(TRACE_HEX, 'hex'),
                spanId: Buffer.from(SPAN_HEX, 'hex'),
                parentSpanId: Buffer.alloc(0), // empty → root
                name: 'agent_cache.llm.check',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000000001000000',
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
  });
  return Buffer.from(Req.encode(msg).finish());
}

describe('decodeOtlpTraceProtobuf', () => {
  it('preserves fixed64 nanosecond precision (not rounded to a JS number)', () => {
    // Values NOT representable exactly as a double — a Number round-trip would round.
    const START = '1700000000123456789';
    const END = '1700000000987654321';
    const msg = Req.fromObject({
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: '@betterdb/agent-cache' },
              spans: [
                {
                  traceId: Buffer.from(TRACE_HEX, 'hex'),
                  spanId: Buffer.from(SPAN_HEX, 'hex'),
                  name: 'x',
                  startTimeUnixNano: START,
                  endTimeUnixNano: END,
                },
              ],
            },
          ],
        },
      ],
    });
    const decoded = decodeOtlpTraceProtobuf(Buffer.from(Req.encode(msg).finish()));
    const span = decoded.resourceSpans![0].scopeSpans![0].spans![0] as any;
    expect(String(span.startTimeUnixNano)).toBe(START);
    expect(String(span.endTimeUnixNano)).toBe(END);
  });

  it('decodes protobuf into the OTLP/JSON shape (hex ids, string nanos)', () => {
    const decoded = decodeOtlpTraceProtobuf(encode());
    const span = decoded.resourceSpans![0].scopeSpans![1 - 1].spans![0] as any;

    expect(span.traceId).toBe(TRACE_HEX);
    expect(span.spanId).toBe(SPAN_HEX);
    expect(span.parentSpanId).toBe(''); // empty bytes → root
    expect(span.name).toBe('agent_cache.llm.check');
    expect(String(span.startTimeUnixNano)).toBe('1700000000000000000');
    expect(decoded.resourceSpans![0].resource!.attributes![0].value!.stringValue).toBe('svc');
    expect(span.attributes[0].value.boolValue).toBe(true);
    expect(span.attributes[1].value.stringValue).toBe('gpt-4o-mini');
  });

  it('feeds cleanly through OtelIngestService into storage', async () => {
    const storage = new MemoryAdapter() as unknown as StoragePort;
    await storage.initialize();
    try {
      const decoded = decodeOtlpTraceProtobuf(encode());
      const res = await new OtelIngestService(storage).ingest(decoded, 1);
      expect(res.stored).toBe(1);

      const spans = await storage.getOtelTraceSpans(TRACE_HEX);
      expect(spans).toHaveLength(1);
      expect(spans[0].scopeName).toBe('@betterdb/agent-cache');
      expect(spans[0].parentSpanId).toBeNull();
      expect(spans[0].durationNs).toBe(1_000_000);
      expect(JSON.parse(spans[0].attributes)['cache.model']).toBe('gpt-4o-mini');
    } finally {
      await storage.close();
    }
  });
});
