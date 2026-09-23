import * as protobuf from 'protobufjs';
import {
  decodeOtlpMetricsProtobuf,
  encodeOtlpMetricsResponse,
  otlpMetricsRoot,
} from '../otlp-metrics-protobuf';

const UPSTREAM = `
syntax = "proto3";
package up;
message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; string schema_url = 3; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message ScopeMetrics { InstrumentationScope scope = 1; repeated Metric metrics = 2; string schema_url = 3; }
message InstrumentationScope { string name = 1; string version = 2; }
message Metric {
  string name = 1;
  string description = 2;
  string unit = 3;
  oneof data {
    Gauge gauge = 5;
    Sum sum = 7;
    Histogram histogram = 9;
    ExponentialHistogram exponential_histogram = 10;
    Summary summary = 11;
  }
  repeated KeyValue metadata = 12;
}
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; AggregationTemporality aggregation_temporality = 2; bool is_monotonic = 3; }
message Histogram { repeated HistogramDataPoint data_points = 1; AggregationTemporality aggregation_temporality = 2; }
message ExponentialHistogram { repeated ExponentialHistogramDataPoint data_points = 1; AggregationTemporality aggregation_temporality = 2; }
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
  repeated Exemplar exemplars = 5;
  uint32 flags = 8;
}
message Exemplar { fixed64 time_unix_nano = 2; oneof value { double as_double = 3; sfixed64 as_int = 6; } }
message HistogramDataPoint {
  repeated KeyValue attributes = 9;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  repeated fixed64 bucket_counts = 6;
  repeated double explicit_bounds = 7;
}
message ExponentialHistogramDataPoint {
  repeated KeyValue attributes = 1;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  sint32 scale = 6;
}
message SummaryDataPoint {
  repeated KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
}
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; } }
`;

const RequestType = protobuf.parse(UPSTREAM, { keepCase: false }).root.lookupType('up.ExportMetricsServiceRequest');

function encode(payload: Record<string, unknown>): Buffer {
  return Buffer.from(RequestType.encode(RequestType.fromObject(payload)).finish());
}

const NOW = '1700000000123456789';

const payload = {
  resourceMetrics: [
    {
      schemaUrl: 'https://opentelemetry.io/schemas/1.9.0',
      resource: {
        droppedAttributesCount: 1,
        attributes: [
          { key: 'server.address', value: { stringValue: 'cache.internal' } },
          { key: 'server.port', value: { intValue: '6379' } },
          { key: 'redis.version', value: { stringValue: '7.2.4' } },
        ],
      },
      scopeMetrics: [
        {
          scope: { name: 'otelcol/redisreceiver', version: '0.110.0' },
          metrics: [
            {
              name: 'redis.memory.used',
              description: 'bytes',
              unit: 'By',
              gauge: { dataPoints: [{ timeUnixNano: NOW, asInt: '9007199254740993', flags: 1 }] },
            },
            {
              name: 'redis.cpu.time',
              unit: 's',
              sum: {
                aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [{ key: 'state', value: { stringValue: 'sys' } }],
                    startTimeUnixNano: '1690000000000000000',
                    timeUnixNano: NOW,
                    asDouble: 1.25,
                    exemplars: [{ timeUnixNano: NOW, asDouble: 2 }],
                  },
                ],
              },
            },
            {
              name: 'redis.keys.expired',
              sum: { aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA', dataPoints: [{ timeUnixNano: NOW, asInt: '0' }] },
            },
            {
              name: 'redis.cmd.latency',
              histogram: {
                aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
                dataPoints: [
                  { timeUnixNano: NOW, count: '3', sum: 1.5, bucketCounts: ['1', '2'], explicitBounds: [1] },
                  { timeUnixNano: NOW, count: '1' },
                ],
              },
            },
            { name: 'x.summary', summary: { dataPoints: [{ timeUnixNano: NOW, count: '1', sum: 2 }] } },
            {
              name: 'x.exp',
              exponentialHistogram: {
                aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
                dataPoints: [{ timeUnixNano: NOW, count: '1', scale: 2 }],
              },
            },
          ],
        },
      ],
    },
  ],
};

describe('decodeOtlpMetricsProtobuf', () => {
  const decoded = decodeOtlpMetricsProtobuf(encode(payload));
  const resource = decoded.resourceMetrics![0];
  const metrics = resource.scopeMetrics![0].metrics!;

  it('decodes resource attributes', () => {
    expect(resource.resource?.attributes).toEqual([
      { key: 'server.address', value: { stringValue: 'cache.internal' } },
      { key: 'server.port', value: { intValue: '6379' } },
      { key: 'redis.version', value: { stringValue: '7.2.4' } },
    ]);
  });

  it('keeps 64-bit integers and timestamps exact', () => {
    expect(metrics[0]).toMatchObject({
      name: 'redis.memory.used',
      unit: 'By',
      gauge: { dataPoints: [{ timeUnixNano: NOW, asInt: '9007199254740993' }] },
    });
  });

  it('decodes sums with temporality, attributes and doubles', () => {
    expect(metrics[1]).toMatchObject({
      name: 'redis.cpu.time',
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [{ attributes: [{ key: 'state', value: { stringValue: 'sys' } }], timeUnixNano: NOW, asDouble: 1.25 }],
      },
    });
    expect(metrics[2]).toMatchObject({ sum: { aggregationTemporality: 1, dataPoints: [{ asInt: '0' }] } });
  });

  it('recognises and counts non-number metric kinds', () => {
    expect(metrics[3].histogram?.dataPoints).toHaveLength(2);
    expect(metrics[4].summary?.dataPoints).toHaveLength(1);
    expect(metrics[5].exponentialHistogram?.dataPoints).toHaveLength(1);
  });

  it('throws on bytes that are not a valid message', () => {
    expect(() => decodeOtlpMetricsProtobuf(Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff]))).toThrow();
  });
});

describe('encodeOtlpMetricsResponse', () => {
  const ResponseType = otlpMetricsRoot.lookupType(
    'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse',
  );

  it('encodes full success as zero bytes', () => {
    expect(encodeOtlpMetricsResponse(null)).toHaveLength(0);
  });

  it('encodes a partial success', () => {
    const buf = encodeOtlpMetricsResponse({ rejectedDataPoints: 5, errorMessage: 'unknown_instance=5' });
    expect(ResponseType.toObject(ResponseType.decode(buf), { longs: String })).toEqual({
      partialSuccess: { rejectedDataPoints: '5', errorMessage: 'unknown_instance=5' },
    });
  });
});
