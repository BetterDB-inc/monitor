import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MetricsController } from '../metrics.controller';
import { MetricsService } from '../metrics.service';
import { ClusterDiscoveryService } from '../../cluster/cluster-discovery.service';
import { ClusterMetricsService } from '../../cluster/cluster-metrics.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ExternalConnectionUnsupportedError } from '../../external-metrics/external-connection-unsupported.error';
import { ExternalConnectionUnsupportedFilter } from '../../external-metrics/external-connection-unsupported.filter';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';
import { ExternalMetricsAdapter } from '../../external-metrics/external-metrics.adapter';

describe('MetricsController with an external connection', () => {
  let app: NestFastifyApplication;
  const store = new ExternalMetricsStore();
  const directClient = {
    getSlowLog: jest.fn().mockResolvedValue([]),
    getCapabilities: jest.fn().mockReturnValue({ hasCommandLog: true }),
    getCommandLog: jest.fn(),
  };
  const clients: Record<string, unknown> = {
    'ext-1': new ExternalMetricsAdapter('ext-1', store),
    'direct-1': directClient,
  };
  const configs: Record<string, { host: string; port: number; connectionType: 'external' | 'direct' }> = {
    'ext-1': { host: 'cache.internal', port: 6379, connectionType: 'external' },
    'direct-1': { host: 'polled.internal', port: 6379, connectionType: 'direct' },
  };
  const registry = {
    getDefaultId: () => 'ext-1',
    get: (id?: string) => clients[id ?? 'ext-1'],
    getConfig: (id?: string) => configs[id ?? 'ext-1'] ?? null,
  };
  const storage = { getSlowLogEntries: jest.fn().mockResolvedValue([]) };

  beforeAll(async () => {
    store.apply('ext-1', [
      { target: { kind: 'scalar', section: 'memory', field: 'used_memory' }, value: '1024', timeMs: Date.now() },
    ]);
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        MetricsService,
        { provide: ConnectionRegistry, useValue: registry },
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ClusterDiscoveryService, useValue: {} },
        { provide: ClusterMetricsService, useValue: {} },
        { provide: APP_FILTER, useClass: ExternalConnectionUnsupportedFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string, connectionId?: string) =>
    app.inject({ method: 'GET', url, headers: connectionId ? { 'x-connection-id': connectionId } : {} });

  it('answers a live-only endpoint with the 501 contract', async () => {
    const res = await get('/metrics/slowlog', 'ext-1');
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({
      statusCode: 501,
      code: 'EXTERNAL_CONNECTION_UNSUPPORTED',
      method: 'getSlowLog',
      message: 'getSlowLog is not available for OTLP-ingested connections',
    });
  });

  it('resolves the default connection when no header is sent', async () => {
    const res = await get('/metrics/commandlog');
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'EXTERNAL_CONNECTION_UNSUPPORTED', method: 'getCommandLog' });
  });

  it('serves INFO-backed endpoints for an external connection', async () => {
    const res = await get('/metrics/info', 'ext-1');
    expect(res.statusCode).toBe(200);
    expect(res.json().memory.used_memory).toBe('1024');
  });

  it('serves storage-backed endpoints for an external connection', async () => {
    const res = await get('/metrics/slowlog/patterns', 'ext-1');
    expect(res.statusCode).toBe(200);
    expect(storage.getSlowLogEntries).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'ext-1' }));
  });

  it('leaves direct connections untouched', async () => {
    const res = await get('/metrics/slowlog', 'direct-1');
    expect(res.statusCode).toBe(200);
    expect(directClient.getSlowLog).toHaveBeenCalled();
  });

  it('does not swallow the typed error in the commandlog catch branch', async () => {
    directClient.getCommandLog.mockRejectedValueOnce(new ExternalConnectionUnsupportedError('getCommandLog'));
    const res = await get('/metrics/commandlog', 'direct-1');
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'EXTERNAL_CONNECTION_UNSUPPORTED', method: 'getCommandLog' });
  });
});
