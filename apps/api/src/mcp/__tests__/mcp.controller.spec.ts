/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { ClusterDiscoveryService } from '../../cluster/cluster-discovery.service';
import { McpController } from '../mcp.controller';

describe('McpController', () => {
  let registry: { get: jest.Mock };
  let metricsService: { getHealthSummary: jest.Mock };
  let controller: McpController;

  beforeEach(() => {
    registry = {
      get: jest.fn().mockReturnValue({
        getInfoParsed: jest.fn().mockResolvedValue({ server: {} }),
      }),
    };
    metricsService = {
      getHealthSummary: jest.fn().mockResolvedValue({ status: 'ok' }),
    };

    controller = new McpController(
      registry as any,
      metricsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('preserves not found errors from connection lookup', async () => {
    registry.get.mockImplementationOnce(() => {
      throw new NotFoundException("Connection 'missing' not found.");
    });

    await expect(controller.getInfo('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('preserves not found errors from services that resolve an instance id', async () => {
    metricsService.getHealthSummary.mockRejectedValueOnce(
      new NotFoundException("Connection 'missing' not found."),
    );

    await expect(controller.getHealth('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports a cluster node its peers suspect as suspect, and one they agreed has failed as failed', async () => {
    const node = { master: '-', pingSent: 0, pongReceived: 0, configEpoch: 1, linkState: 'connected', slots: [] };
    const clusterRegistry = {
      getDefaultId: jest.fn().mockReturnValue('conn-1'),
      getNodeAvailabilityZones: jest.fn().mockReturnValue(undefined),
      get: jest.fn().mockReturnValue({
        getClusterNodes: jest.fn().mockResolvedValue([
          { ...node, id: 'a', address: '10.0.0.1:6379@16379', flags: ['master'] },
          { ...node, id: 'b', address: '10.0.0.2:6379@16379', flags: ['master', 'fail?'] },
          { ...node, id: 'c', address: '10.0.0.3:6379@16379', flags: ['master', 'fail'] },
        ]),
        getClusterShards: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const discovery = new ClusterDiscoveryService(clusterRegistry as any);
    const withDiscovery = new McpController(
      clusterRegistry as any,
      metricsService as any,
      {} as any,
      {} as any,
      discovery,
      {} as any,
      {} as any,
    );

    const nodes = await withDiscovery.getClusterNodes('conn-1');

    expect(nodes).toEqual([
      expect.objectContaining({ id: 'a', state: 'healthy' }),
      expect.objectContaining({ id: 'b', state: 'suspect' }),
      expect.objectContaining({ id: 'c', state: 'failed' }),
    ]);
  });

  it('still wraps non-http failures in a generic 500', async () => {
    registry.get.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });

    try {
      await controller.getInfo('conn-1');
      throw new Error('Expected getInfo to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).message).toBe('Failed to get info');
      expect((error as HttpException).getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    }
  });

  it('re-ranks hot keys globally across logical databases instead of returning interleaved per-db ranks', async () => {
    // Stored rows are interleaved by per-db rank (db0#1, db1#1, db0#2); a naive
    // storage limit:2 would return db0#1 + db1#1 and drop db0#2 (hotter than
    // db1#1). The endpoint must fetch the full capture and re-rank globally.
    const storageClient = {
      getHotKeys: jest.fn().mockResolvedValue([
        { id: 'd0a', keyName: 'd0a', signalType: 'lfu', freqScore: 200, rank: 1, db: 0, capturedAt: 1, connectionId: 'c' },
        { id: 'd1a', keyName: 'd1a', signalType: 'lfu', freqScore: 50, rank: 1, db: 1, capturedAt: 1, connectionId: 'c' },
        { id: 'd0b', keyName: 'd0b', signalType: 'lfu', freqScore: 190, rank: 2, db: 0, capturedAt: 1, connectionId: 'c' },
      ]),
    };
    const c = new McpController(
      registry as any,
      metricsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      storageClient as any,
    );

    const res: any = await c.getHotKeys('conn-1', undefined, undefined, '2');

    expect(res.map((r: any) => r.keyName)).toEqual(['d0a', 'd0b']);
    expect(res.map((r: any) => r.rank)).toEqual([1, 2]);
    // Fetched the whole latest capture (fetch cap), not the caller's limit.
    expect(storageClient.getHotKeys).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10_000, latest: true }),
    );
  });

  it('keeps the connection id in the log line even though the client message stays generic', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    registry.get.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });

    await expect(controller.getInfo('conn-42')).rejects.toBeInstanceOf(HttpException);

    expect(errorSpy).toHaveBeenCalledWith('Failed to get info for conn-42', expect.any(String));
    errorSpy.mockRestore();
  });
});
