import { gzipSync, deflateSync } from 'zlib';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { registerOtlpBodyParsing } from '../otlp-body-parsing';
import { OtelIngestController } from '../otel-ingest.controller';
import { OtelIngestService } from '../otel-ingest.service';
import { OtelMetricsIngestController } from '../../external-metrics/otel-metrics-ingest.controller';
import { OtelMetricsIngestService } from '../../external-metrics/otel-metrics-ingest.service';
import { otlpMetricsRoot } from '../../external-metrics/otlp-metrics-protobuf';

const MetricsRequest = otlpMetricsRoot.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest');

const metricsJson = {
  resourceMetrics: [
    {
      resource: { attributes: [{ key: 'server.address', value: { stringValue: 'cache.internal' } }] },
      scopeMetrics: [{ metrics: [{ name: 'redis.uptime', gauge: { dataPoints: [{ asInt: '5' }] } }] }],
    },
  ],
};

const cleanResult = {
  accepted: 1,
  dropped: {
    unidentified: 0,
    unknown_instance: 0,
    already_polled: 0,
    unsupported_type: 0,
    unsupported_temporality: 0,
    unmapped_metric: 0,
    cardinality_limit: 0,
  },
};

describe('OTLP request body parsing', () => {
  const ENV_KEYS = ['OTEL_INGEST_ENABLED', 'OTEL_INGEST_TOKEN', 'CLOUD_MODE'] as const;
  let saved: Record<string, string | undefined>;
  let app: NestFastifyApplication;
  const metricsIngest = jest.fn();
  const tracesIngest = jest.fn();

  beforeAll(async () => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [OtelMetricsIngestController, OtelIngestController],
      providers: [
        { provide: OtelMetricsIngestService, useValue: { ingest: metricsIngest } },
        { provide: OtelIngestService, useValue: { ingest: tracesIngest } },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerOtlpBodyParsing(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  beforeEach(() => {
    metricsIngest.mockReset().mockReturnValue(cleanResult);
    tracesIngest.mockReset().mockResolvedValue({ stored: 0, received: 0 });
  });

  const post = (url: string, contentType: string, payload: Buffer, encoding?: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': contentType, ...(encoding ? { 'content-encoding': encoding } : {}) },
      payload,
    });

  it('accepts a gzipped protobuf metrics body', async () => {
    const encoded = Buffer.from(MetricsRequest.encode(MetricsRequest.fromObject(metricsJson)).finish());
    const res = await post('/v1/external/metrics', 'application/x-protobuf', gzipSync(encoded), 'gzip');
    expect(res.statusCode).toBe(200);
    expect(metricsIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceMetrics: [expect.objectContaining({ scopeMetrics: [expect.any(Object)] })],
      }),
    );
  });

  it('accepts a gzipped JSON metrics body', async () => {
    const res = await post('/v1/external/metrics', 'application/json', gzipSync(JSON.stringify(metricsJson)), 'gzip');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(metricsIngest).toHaveBeenCalledWith(metricsJson);
  });

  it('accepts a deflated JSON metrics body', async () => {
    const res = await post('/v1/external/metrics', 'application/json', deflateSync(JSON.stringify(metricsJson)), 'deflate');
    expect(res.statusCode).toBe(200);
    expect(metricsIngest).toHaveBeenCalledWith(metricsJson);
  });

  it('still accepts an uncompressed JSON metrics body', async () => {
    const res = await post('/v1/external/metrics', 'application/json', Buffer.from(JSON.stringify(metricsJson)));
    expect(res.statusCode).toBe(200);
    expect(metricsIngest).toHaveBeenCalledWith(metricsJson);
  });

  it('accepts a gzipped JSON traces body', async () => {
    const traces = { resourceSpans: [] };
    const res = await post('/v1/traces', 'application/json', gzipSync(JSON.stringify(traces)), 'gzip');
    expect(res.statusCode).toBe(200);
    expect(tracesIngest).toHaveBeenCalledWith(traces, expect.any(Number));
  });

  it('rejects a body that inflates past the cap with 413', async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    const res = await post('/v1/external/metrics', 'application/json', bomb, 'gzip');
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toBe('Decompressed gzip body is too large');
    expect(metricsIngest).not.toHaveBeenCalled();
  });

  it('rejects a corrupt gzip body with 400', async () => {
    const res = await post('/v1/traces', 'application/json', Buffer.from('not gzip at all'), 'gzip');
    expect(res.statusCode).toBe(400);
    expect(tracesIngest).not.toHaveBeenCalled();
  });

  describe('with an ingestion token', () => {
    beforeEach(() => {
      process.env.OTEL_INGEST_TOKEN = 'secret';
    });
    afterEach(() => {
      delete process.env.OTEL_INGEST_TOKEN;
    });

    it('rejects an unauthenticated compressed body with 401 before decompressing it', async () => {
      const res = await post('/v1/traces', 'application/json', Buffer.from('not gzip at all'), 'gzip');
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe('Invalid ingestion token');
      expect(tracesIngest).not.toHaveBeenCalled();
    });

    it('decompresses an authenticated body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/external/metrics',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: 'Bearer secret' },
        payload: gzipSync(JSON.stringify(metricsJson)),
      });
      expect(res.statusCode).toBe(200);
      expect(metricsIngest).toHaveBeenCalledWith(metricsJson);
    });
  });

  it('returns 404 for a compressed body when ingestion is disabled', async () => {
    process.env.OTEL_INGEST_ENABLED = 'false';
    try {
      const res = await post('/v1/external/metrics', 'application/json', Buffer.from('not gzip at all'), 'gzip');
      expect(res.statusCode).toBe(404);
    } finally {
      delete process.env.OTEL_INGEST_ENABLED;
    }
  });

  it('rejects an unknown content encoding with 415', async () => {
    const res = await post('/v1/external/metrics', 'application/json', Buffer.from('{}'), 'br');
    expect(res.statusCode).toBe(415);
    expect(res.json().message).toBe('Unsupported content encoding: br');
    expect(metricsIngest).not.toHaveBeenCalled();
  });
});
