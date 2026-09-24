import * as protobuf from 'protobufjs';
import Long from 'long';
import type { OtlpMetricsRequest, PartialSuccess } from './otlp-metrics-types';

protobuf.util.Long = Long as unknown as typeof protobuf.util.Long;
protobuf.configure();

const PROTO_SRC = `
syntax = "proto3";
package opentelemetry.proto.collector.metrics.v1;

message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ExportMetricsServiceResponse { ExportMetricsPartialSuccess partial_success = 1; }
message ExportMetricsPartialSuccess { int64 rejected_data_points = 1; string error_message = 2; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
message Resource { repeated KeyValue attributes = 1; }
message ScopeMetrics { InstrumentationScope scope = 1; repeated Metric metrics = 2; }
message InstrumentationScope { string name = 1; }
message Metric {
  string name = 1;
  string unit = 3;
  oneof data {
    Gauge gauge = 5;
    Sum sum = 7;
    Histogram histogram = 9;
    ExponentialHistogram exponential_histogram = 10;
    Summary summary = 11;
  }
}
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum {
  repeated NumberDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
  bool is_monotonic = 3;
}
message Histogram { repeated HistogramDataPoint data_points = 1; AggregationTemporality aggregation_temporality = 2; }
message ExponentialHistogram {
  repeated ExponentialHistogramDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
}
message Summary { repeated SummaryDataPoint data_points = 1; }
enum AggregationTemporality {
  AGGREGATION_TEMPORALITY_UNSPECIFIED = 0;
  AGGREGATION_TEMPORALITY_DELTA = 1;
  AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
}
message NumberDataPoint {
  repeated KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  oneof value { double as_double = 4; sfixed64 as_int = 6; }
  uint32 flags = 8;
}
message HistogramDataPoint { repeated KeyValue attributes = 9; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3; }
message ExponentialHistogramDataPoint {
  repeated KeyValue attributes = 1;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
}
message SummaryDataPoint { repeated KeyValue attributes = 7; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
  }
}
`;

export const otlpMetricsRoot = protobuf.parse(PROTO_SRC, { keepCase: false }).root;

const RequestType = otlpMetricsRoot.lookupType(
  'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest',
);
const ResponseType = otlpMetricsRoot.lookupType(
  'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse',
);

export function decodeOtlpMetricsProtobuf(buf: Buffer | Uint8Array): OtlpMetricsRequest {
  const message = RequestType.decode(buf);
  return RequestType.toObject(message, {
    longs: String,
    bytes: Array,
    defaults: false,
    arrays: true,
    objects: true,
  }) as OtlpMetricsRequest;
}

export function encodeOtlpMetricsResponse(partial: PartialSuccess | null): Buffer {
  if (!partial) return Buffer.alloc(0);
  const message = ResponseType.fromObject({ partialSuccess: partial });
  return Buffer.from(ResponseType.encode(message).finish());
}
