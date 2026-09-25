import { HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { OtelMetricsIngestController } from '../otel-metrics-ingest.controller';
import { OtelMetricsIngestService, type IngestResult } from '../otel-metrics-ingest.service';
import { ExternalMetricsStore } from '../external-metrics-store';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import { otlpMetricsRoot } from '../otlp-metrics-protobuf';
import { OtelIngestController } from '../../ai-observability/otel-ingest.controller';
import type { OtelIngestService } from '../../ai-observability/otel-ingest.service';

const clean: IngestResult = {
  accepted: 3,
  dropped: {
    unidentified: 0,
    unknown_instance: 0,
    already_polled: 0,
    unsupported_type: 0,
    unsupported_temporality: 0,
    unmapped_metric: 0,
    invalid_value: 0,
    cardinality_limit: 0,
  },
};

const partial: IngestResult = {
  accepted: 1,
  dropped: { ...clean.dropped, unknown_instance: 12, unmapped_metric: 3 },
};

function makeCtrl(result: IngestResult = clean) {
  const service = { ingest: jest.fn().mockReturnValue(result) } as unknown as OtelMetricsIngestService & {
    ingest: jest.Mock;
  };
  return { ctrl: new OtelMetricsIngestController(service), service };
}

function fakeReply() {
  return { header: jest.fn() } as unknown as FastifyReply & { header: jest.Mock };
}

const RequestType = otlpMetricsRoot.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest');
const ResponseType = otlpMetricsRoot.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse');

describe('OtelMetricsIngestController.ingestMetrics', () => {
  const ENV_KEYS = ['OTEL_INGEST_ENABLED', 'OTEL_INGEST_TOKEN', 'CLOUD_MODE'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it.each([
    ['resourceMetrics is not an array', { resourceMetrics: 5 }],
    ['a resourceMetrics entry is null', { resourceMetrics: [null] }],
    ['a metrics entry is null', { resourceMetrics: [{ scopeMetrics: [{ metrics: [null] }] }] }],
    ['a resource attribute is null', { resourceMetrics: [{ resource: { attributes: [null] } }] }],
    [
      'a data point attribute is null',
      {
        resourceMetrics: [
          { scopeMetrics: [{ metrics: [{ name: 'redis.uptime', gauge: { dataPoints: [{ attributes: [null] }] } }] }] },
        ],
      },
    ],
    ['a metric name is not a string', { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 5 }] }] }] }],
    [
      'data point flags are not a number',
      {
        resourceMetrics: [
          { scopeMetrics: [{ metrics: [{ name: 'redis.uptime', gauge: { dataPoints: [{ flags: 'x' }] } }] }] },
        ],
      },
    ],
  ])('returns 400 without ingesting when %s', (_label, body) => {
    const { ctrl, service } = makeCtrl();
    let status: number | undefined;
    try {
      ctrl.ingestMetrics(fakeReply(), body as never, 'application/json');
    } catch (err) {
      status = err instanceof HttpException ? err.getStatus() : -1;
    }
    expect(status).toBe(400);
    expect(service.ingest).not.toHaveBeenCalled();
  });

  describe('attribute validation against the real ingest service', () => {
    const realCtrl = () => {
      const registry = {
        findByHostPort: jest.fn().mockReturnValue({ id: 'ext', connectionType: 'external' }),
      } as unknown as ConnectionRegistry;
      return new OtelMetricsIngestController(new OtelMetricsIngestService(registry, new ExternalMetricsStore()));
    };
    const withResourceAttrs = (attributes: unknown[]) => ({
      resourceMetrics: [
        {
          resource: { attributes },
          scopeMetrics: [{ metrics: [{ name: 'redis.uptime', gauge: { dataPoints: [{ asInt: '1' }] } }] }],
        },
      ],
    });
    const statusOf = (body: unknown): number | null => {
      try {
        realCtrl().ingestMetrics(fakeReply(), body as never, 'application/json');
        return null;
      } catch (err) {
        return err instanceof HttpException ? err.getStatus() : -1;
      }
    };

    it.each([
      ['a stringValue is a number', [{ key: 'service.instance.id', value: { stringValue: 42 } }]],
      ['a boolValue is a string', [{ key: 'flag', value: { boolValue: 'true' } }]],
      ['an intValue is a fraction', [{ key: 'server.port', value: { intValue: 6379.5 } }]],
      ['an intValue is an object', [{ key: 'server.port', value: { intValue: {} } }]],
      ['a doubleValue is a string', [{ key: 'ratio', value: { doubleValue: '1.5' } }]],
      ['a key is not a string', [{ key: 5, value: { stringValue: 'x' } }]],
      ['a key is missing', [{ value: { stringValue: 'x' } }]],
      ['a value is not an object', [{ key: 'k', value: 'x' }]],
    ])('returns 400, not 500, when %s', (_label, attributes) => {
      expect(statusOf(withResourceAttrs(attributes))).toBe(400);
    });

    it('returns 400 for malformed scope and data point attributes', () => {
      const scope = {
        resourceMetrics: [{ scopeMetrics: [{ scope: { attributes: [{ key: 'k', value: { stringValue: 1 } }] } }] }],
      };
      const point = {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'redis.db.keys',
                    gauge: { dataPoints: [{ asInt: '1', attributes: [{ key: 'db', value: { stringValue: 0 } }] }] },
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(statusOf(scope)).toBe(400);
      expect(statusOf(point)).toBe(400);
    });

    it('reports the offending path in the 400 message', () => {
      expect(() =>
        realCtrl().ingestMetrics(
          fakeReply(),
          withResourceAttrs([{ key: 'service.instance.id', value: { stringValue: 42 } }]) as never,
          'application/json',
        ),
      ).toThrow(/^Malformed OTLP metrics request at resourceMetrics\.0\.resource\.attributes\.0\.value\.stringValue: /);
    });

    it('accepts every well-formed AnyValue variant', () => {
      const attributes = [
        { key: 'server.address', value: { stringValue: 'cache.internal' } },
        { key: 'server.port', value: { intValue: 6379 } },
        { key: 'i', value: { intValue: '-5' } },
        { key: 'd', value: { doubleValue: 1.5 } },
        { key: 'b', value: { boolValue: false } },
        { key: 'a', value: { arrayValue: { values: [{ stringValue: 'x' }] } } },
        { key: 'kv', value: { kvlistValue: { values: [{ key: 'x', value: { intValue: '1' } }] } } },
        { key: 'raw', value: { bytesValue: 'AQI=' } },
        { key: 'empty', value: {} },
        { key: 'none' },
      ];
      expect(statusOf(withResourceAttrs(attributes))).toBeNull();
    });
  });

  it('passes a realistic collector JSON export through to ingest', () => {
    const { ctrl, service } = makeCtrl();
    const body = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'server.address', value: { stringValue: '10.0.0.1' } },
              { key: 'server.port', value: { intValue: '6379' } },
            ],
          },
          scopeMetrics: [
            {
              scope: { name: 'otelcol/redisreceiver', version: '0.110.0' },
              metrics: [
                {
                  name: 'redis.uptime',
                  unit: 's',
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [{ asInt: '42', timeUnixNano: '1700000000000000000' }],
                  },
                },
                {
                  name: 'redis.memory.used',
                  gauge: {
                    dataPoints: [{ asInt: '1024', attributes: [{ key: 'db', value: { stringValue: '0' } }] }],
                  },
                },
                { name: 'redis.latency', histogram: { dataPoints: [{ count: '3', bucketCounts: ['1', '2'] }] } },
              ],
            },
          ],
        },
      ],
    };

    expect(ctrl.ingestMetrics(fakeReply(), body as never, 'application/json')).toEqual({});
    expect(service.ingest).toHaveBeenCalledWith(body);
  });

  it('returns {} for a fully accepted JSON request', () => {
    const { ctrl, service } = makeCtrl();
    const reply = fakeReply();
    const body = { resourceMetrics: [] };
    expect(ctrl.ingestMetrics(reply, body, 'application/json')).toEqual({});
    expect(service.ingest).toHaveBeenCalledWith(body);
    expect(reply.header).not.toHaveBeenCalled();
  });

  it('returns partialSuccess for JSON with string-encoded counts', () => {
    const { ctrl } = makeCtrl(partial);
    expect(ctrl.ingestMetrics(fakeReply(), {}, 'application/json')).toEqual({
      partialSuccess: { rejectedDataPoints: '15', errorMessage: 'unknown_instance=12 unmapped_metric=3' },
    });
  });

  it('decodes protobuf and returns zero bytes on full success', () => {
    const { ctrl, service } = makeCtrl();
    const reply = fakeReply();
    const body = Buffer.from(RequestType.encode(RequestType.fromObject({ resourceMetrics: [{}] })).finish());
    const res = ctrl.ingestMetrics(reply, body, 'application/x-protobuf');
    expect(Buffer.isBuffer(res) && res.length).toBe(0);
    expect(reply.header).toHaveBeenCalledWith('content-type', 'application/x-protobuf');
    expect(service.ingest).toHaveBeenCalledWith(expect.objectContaining({ resourceMetrics: [expect.any(Object)] }));
  });

  it('encodes partialSuccess for protobuf', () => {
    const { ctrl } = makeCtrl(partial);
    const res = ctrl.ingestMetrics(fakeReply(), Buffer.alloc(0), 'application/x-protobuf') as Buffer;
    expect(ResponseType.toObject(ResponseType.decode(res), { longs: String })).toEqual({
      partialSuccess: { rejectedDataPoints: '15', errorMessage: 'unknown_instance=12 unmapped_metric=3' },
    });
  });

  it('rejects a non-buffer protobuf body and undecodable bytes with 400', () => {
    const { ctrl } = makeCtrl();
    expect(() => ctrl.ingestMetrics(fakeReply(), {}, 'application/x-protobuf')).toThrow('Expected a protobuf body');
    expect(() => ctrl.ingestMetrics(fakeReply(), Buffer.from([0x0a, 0xff, 0xff, 0xff]), 'application/x-protobuf')).toThrow(
      /Failed to decode OTLP protobuf/,
    );
  });

  describe('auth parity with /v1/traces', () => {
    const traces = () =>
      new OtelIngestController({ ingest: jest.fn(async () => ({ stored: 0, received: 0 })) } as unknown as OtelIngestService);

    const statusOf = async (fn: () => unknown): Promise<number | null> => {
      try {
        await fn();
        return null;
      } catch (err) {
        return err instanceof HttpException ? err.getStatus() : -1;
      }
    };

    it.each([
      ['disabled', { OTEL_INGEST_ENABLED: 'false' }, undefined],
      ['cloud without token', { CLOUD_MODE: 'true' }, undefined],
      ['wrong token', { OTEL_INGEST_TOKEN: 't' }, 'Bearer x'],
      ['right token', { OTEL_INGEST_TOKEN: 't' }, 'Bearer t'],
      ['self-hosted anonymous', {}, undefined],
    ])('%s', async (_label, env: Record<string, string>, auth) => {
      Object.assign(process.env, env);
      const metricsStatus = await statusOf(() => makeCtrl().ctrl.ingestMetrics(fakeReply(), {}, 'application/json', auth));
      const tracesStatus = await statusOf(() => traces().ingestTraces(fakeReply(), {}, 'application/json', auth));
      expect(metricsStatus).toBe(tracesStatus);
    });
  });
});
