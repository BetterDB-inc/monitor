import * as protobuf from 'protobufjs';
import Long from 'long';
import type { OtlpTraceRequest } from './otel-ingest.service';

// OTLP timestamps are fixed64 nanoseconds, always above Number.MAX_SAFE_INTEGER.
// Without a Long backend, protobufjs decodes them to imprecise JS numbers and
// rounds. Wire up `long` explicitly so `longs: String` yields exact values.
protobuf.util.Long = Long as unknown as typeof protobuf.util.Long;
protobuf.configure();

/**
 * Minimal OTLP trace proto (subset of the fields Monitor reads). Field numbers
 * match the stable OTLP v1 spec; protobufjs skips any undeclared fields, so we
 * only need to declare what we consume. After decode + id/time normalization the
 * object matches the OTLP/JSON shape OtelIngestService.ingest() already accepts.
 */
const PROTO_SRC = `
syntax = "proto3";
package opentelemetry.proto.collector.trace.v1;

message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message Resource { repeated KeyValue attributes = 1; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; }
message InstrumentationScope { string name = 1; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  bytes parent_span_id = 4;
  string name = 5;
  uint32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  Status status = 15;
}
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
  }
}
message Status { string message = 2; uint32 code = 3; }
`;

const RequestType = protobuf
  .parse(PROTO_SRC, { keepCase: false })
  .root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');

/** Decode OTLP/protobuf trace bytes into the OtlpTraceRequest shape. */
export function decodeOtlpTraceProtobuf(buf: Buffer | Uint8Array): OtlpTraceRequest {
  const msg = RequestType.decode(buf);
  const obj = RequestType.toObject(msg, {
    longs: String, // fixed64 / int64 -> string
    bytes: Array, // bytes -> number[]
    defaults: false,
    arrays: true,
    objects: true,
  }) as any;

  for (const rs of obj.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        span.traceId = bytesToHex(span.traceId);
        span.spanId = bytesToHex(span.spanId);
        span.parentSpanId = bytesToHex(span.parentSpanId); // '' when absent -> treated as root
      }
    }
  }
  return obj as OtlpTraceRequest;
}

function bytesToHex(bytes: number[] | Uint8Array | undefined): string {
  if (!bytes || bytes.length === 0) return '';
  let out = '';
  for (const b of bytes) out += (b & 0xff).toString(16).padStart(2, '0');
  return out;
}
