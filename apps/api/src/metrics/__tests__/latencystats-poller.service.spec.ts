/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { Test, TestingModule } from '@nestjs/testing';
import { LatencystatsPollerService } from '../latencystats-poller.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ConnectionContext } from '../../common/services/multi-connection-poller';

describe('LatencystatsPollerService', () => {
  let service: LatencystatsPollerService;
  let storage: jest.Mocked<StoragePort>;

  const makeCtx = (client: any, connectionId = 'conn-1'): ConnectionContext => ({
    connectionId,
    connectionName: 'test',
    client,
    host: 'h',
    port: 6379,
  });

  const clientWith = (info: Record<string, unknown>) => ({
    getInfo: jest.fn().mockResolvedValue(info),
  });

  beforeEach(async () => {
    storage = {
      saveLatencyStatsSamples: jest.fn().mockResolvedValue(1),
      getLatencyStatsHistory: jest.fn().mockResolvedValue([]),
      pruneOldLatencyStatsSamples: jest.fn().mockResolvedValue(0),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LatencystatsPollerService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        {
          provide: ConnectionRegistry,
          useValue: { list: jest.fn().mockReturnValue([]) },
        },
      ],
    }).compile();

    service = module.get(LatencystatsPollerService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists absolute p99 gauges with the server version from the same INFO call', async () => {
    const client = clientWith({
      server: { valkey_version: '8.1.0' },
      latencystats: {
        latency_percentiles_usec_hmget: 'p50=100,p99=2500,p99.9=8000',
      },
    });

    await (service as any).pollConnection(makeCtx(client));

    expect(client.getInfo).toHaveBeenCalledWith(['server', 'latencystats']);
    expect(storage.saveLatencyStatsSamples).toHaveBeenCalledTimes(1);
    const [batch, connId] = storage.saveLatencyStatsSamples.mock.calls[0];
    expect(connId).toBe('conn-1');
    expect(batch[0]).toMatchObject({
      command: 'hmget',
      p50Us: 100,
      p99Us: 2500,
      p999Us: 8000,
      serverVersion: '8.1.0',
    });
  });

  it('falls back to redis_version when valkey_version is absent', async () => {
    const client = clientWith({
      server: { redis_version: '7.2.4' },
      latencystats: { latency_percentiles_usec_get: 'p99=10' },
    });

    await (service as any).pollConnection(makeCtx(client));

    const [batch] = storage.saveLatencyStatsSamples.mock.calls[0];
    expect(batch[0].serverVersion).toBe('7.2.4');
  });

  it('skips commands with p99=0', async () => {
    const client = clientWith({
      server: { valkey_version: '8.1.0' },
      latencystats: {
        latency_percentiles_usec_get: 'p50=0,p99=0,p99.9=0',
        latency_percentiles_usec_set: 'p50=1,p99=5,p99.9=10',
      },
    });

    await (service as any).pollConnection(makeCtx(client));

    const [batch] = storage.saveLatencyStatsSamples.mock.calls[0];
    expect(batch).toHaveLength(1);
    expect(batch[0].command).toBe('set');
  });

  it('is a no-op when the latencystats section is absent (pre-7.0 / tracking off)', async () => {
    const client = clientWith({ server: { redis_version: '6.2.0' } });

    await (service as any).pollConnection(makeCtx(client));
    await (service as any).pollConnection(makeCtx(client));

    expect(storage.saveLatencyStatsSamples).not.toHaveBeenCalled();
    expect(service.getSnapshot('conn-1')).toEqual([]);
  });

  it('prunes old samples at most once per hour per connection', async () => {
    const client = clientWith({
      server: { valkey_version: '8.1.0' },
      latencystats: { latency_percentiles_usec_get: 'p99=10' },
    });

    jest.spyOn(Date, 'now').mockReturnValue(10_000_000);
    await (service as any).pollConnection(makeCtx(client));
    expect(storage.pruneOldLatencyStatsSamples).toHaveBeenCalledTimes(1);

    // 1 minute later: no prune
    (Date.now as jest.Mock).mockReturnValue(10_060_000);
    await (service as any).pollConnection(makeCtx(client));
    expect(storage.pruneOldLatencyStatsSamples).toHaveBeenCalledTimes(1);

    // >1 hour later: prunes again with 7d retention cutoff
    (Date.now as jest.Mock).mockReturnValue(10_000_000 + 61 * 60 * 1000);
    await (service as any).pollConnection(makeCtx(client));
    expect(storage.pruneOldLatencyStatsSamples).toHaveBeenCalledTimes(2);
    const [cutoff, connId] = storage.pruneOldLatencyStatsSamples.mock.calls[1];
    expect(cutoff).toBe(10_000_000 + 61 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000);
    expect(connId).toBe('conn-1');
  });

  it('exposes the latest snapshot via getSnapshot()', async () => {
    const client = clientWith({
      server: { valkey_version: '9.0.1' },
      latencystats: { latency_percentiles_usec_hmget: 'p50=1,p99=99,p99.9=999' },
    });

    jest.spyOn(Date, 'now').mockReturnValue(1234567890);
    await (service as any).pollConnection(makeCtx(client));

    expect(service.getSnapshot('conn-1')).toEqual([
      {
        command: 'hmget',
        p50Us: 1,
        p99Us: 99,
        p999Us: 999,
        serverVersion: '9.0.1',
        capturedAt: 1234567890,
      },
    ]);
    expect(service.getSnapshot('unknown')).toEqual([]);
  });

  it('swallows getInfo failures without persisting', async () => {
    const client = { getInfo: jest.fn().mockRejectedValue(new Error('boom')) };

    await expect((service as any).pollConnection(makeCtx(client))).resolves.toBeUndefined();
    expect(storage.saveLatencyStatsSamples).not.toHaveBeenCalled();
  });
});
