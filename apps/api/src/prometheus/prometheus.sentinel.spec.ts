import { PrometheusService } from './prometheus.service';

describe('PrometheusService scrape refresh', () => {
  it('skips Sentinel connections when refreshing /metrics', async () => {
    const capabilities: Record<string, { isSentinel?: boolean }> = { sentinel: { isSentinel: true }, direct: {} };
    const service = Object.create(PrometheusService.prototype) as PrometheusService;
    const refreshed: string[] = [];
    Object.assign(service, {
      connectionRegistry: {
        list: () => [
          { id: 'sentinel', name: 'sentinel', isConnected: true },
          { id: 'direct', name: 'direct', isConnected: true },
        ],
        get: (id: string) => ({ getCapabilities: () => capabilities[id] }),
      },
      updateMetricsForConnection: async (id: string) => {
        refreshed.push(id);
        return 0;
      },
      updateStorageBasedMetricsForConnection: async () => undefined,
    });

    await service.updateMetrics();

    expect(refreshed).toEqual(['direct']);
  });
});
