import { ConfigService } from '@nestjs/config';
import { PrometheusService } from '../prometheus.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../../health/health.service';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';

const INSTANCES: Record<string, { host: string; port: number }> = {
  'conn-1': { host: '10.0.0.1', port: 6379 },
  'conn-2': { host: '10.0.0.2', port: 6379 },
  'agent-1': { host: 'agent', port: 0 },
  'agent-2': { host: 'agent', port: 0 },
};

const footprint = (model: string, chunksEst: number, bytesEst: number | null) => ({ model, dtype: 'bfloat16', chunksEst, bytesEst });

describe('PrometheusService KV cache metrics', () => {
  let service: PrometheusService;

  beforeEach(() => {
    const registry = {
      getConfig: jest.fn().mockImplementation((id: string) => INSTANCES[id]),
      list: jest.fn().mockReturnValue([]),
      getName: jest.fn().mockReturnValue('primary'),
    } as unknown as ConnectionRegistry;
    service = new PrometheusService(
      {} as StoragePort,
      registry,
      { get: jest.fn().mockReturnValue(5000) } as unknown as ConfigService,
      {} as RuntimeCapabilityTracker,
      {} as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  async function exposition(): Promise<string> {
    return (service as unknown as { registry: { metrics: () => Promise<string> } }).registry.metrics();
  }

  it('exports chunks and bytes per model', async () => {
    service.setKvCacheFootprint('conn-1', [footprint('llama', 10, 1000), footprint('qwen', 4, 400)]);
    const text = await exposition();
    expect(text).toContain('betterdb_kv_cache_chunks{connection="10.0.0.1:6379",connection_id="conn-1",model="llama"} 10');
    expect(text).toContain('betterdb_kv_cache_bytes{connection="10.0.0.1:6379",connection_id="conn-1",model="qwen"} 400');
  });

  it('sums a model served with more than one dtype', async () => {
    service.setKvCacheFootprint('conn-1', [footprint('llama', 10, 1000), { ...footprint('llama', 3, 600), dtype: 'float16' }]);
    const text = await exposition();
    expect(text).toContain('betterdb_kv_cache_chunks{connection="10.0.0.1:6379",connection_id="conn-1",model="llama"} 13');
    expect(text).toContain('betterdb_kv_cache_bytes{connection="10.0.0.1:6379",connection_id="conn-1",model="llama"} 1600');
  });

  it('exports chunks but no byte series when the byte estimate is unknown', async () => {
    service.setKvCacheFootprint('conn-1', [footprint('llama', 10, 1000)]);
    service.setKvCacheFootprint('conn-1', [footprint('llama', 12, null)]);
    const text = await exposition();
    expect(text).toContain('betterdb_kv_cache_chunks{connection="10.0.0.1:6379",connection_id="conn-1",model="llama"} 12');
    expect(text).not.toContain('betterdb_kv_cache_bytes{connection="10.0.0.1:6379",connection_id="conn-1",model="llama"}');
  });

  it('drops the series of a model that is no longer in the footprint', async () => {
    service.setKvCacheFootprint('conn-1', [footprint('llama', 10, 1000), footprint('qwen', 4, 400)]);
    service.setKvCacheFootprint('conn-1', [footprint('llama', 12, 1200)]);
    const text = await exposition();
    expect(text).toContain('betterdb_kv_cache_chunks{connection="10.0.0.1:6379",connection_id="conn-1",model="llama"} 12');
    expect(text).not.toContain('model="qwen"');
  });

  it('replaces hit rate series for a connection', async () => {
    service.setKvCacheHitRates('conn-1', [
      { engine: 'vllm-a', model: 'llama', hitRate: 0.5 },
      { engine: 'vllm-b', model: 'llama', hitRate: 0.1 },
    ]);
    service.setKvCacheHitRates('conn-1', [{ engine: 'vllm-a', model: 'llama', hitRate: 0.75 }]);
    const text = await exposition();
    expect(text).toContain('betterdb_kv_cache_hit_rate{connection="10.0.0.1:6379",connection_id="conn-1",engine="vllm-a",model="llama"} 0.75');
    expect(text).not.toContain('engine="vllm-b"');
  });

  it('removes every hit rate series when the list is empty', async () => {
    service.setKvCacheHitRates('conn-1', [{ engine: 'vllm-a', model: 'llama', hitRate: 0.5 }]);
    service.setKvCacheHitRates('conn-1', []);
    expect(await exposition()).not.toContain('betterdb_kv_cache_hit_rate{');
  });

  it('clears all three families for one connection only', async () => {
    service.setKvCacheFootprint('conn-1', [footprint('llama', 10, 1000)]);
    service.setKvCacheHitRates('conn-1', [{ engine: 'vllm-a', model: 'llama', hitRate: 0.5 }]);
    service.setKvCacheFootprint('conn-2', [footprint('qwen', 4, 400)]);
    service.setKvCacheHitRates('conn-2', [{ engine: 'vllm-b', model: 'qwen', hitRate: 0.3 }]);
    service.clearKvCache('conn-1');
    const text = await exposition();
    expect(text).not.toContain('connection="10.0.0.1:6379",connection_id="conn-1",model="llama"');
    expect(text).not.toContain('engine="vllm-a"');
    expect(text).toContain('betterdb_kv_cache_chunks{connection="10.0.0.2:6379",connection_id="conn-2",model="qwen"} 4');
    expect(text).toContain('betterdb_kv_cache_bytes{connection="10.0.0.2:6379",connection_id="conn-2",model="qwen"} 400');
    expect(text).toContain('betterdb_kv_cache_hit_rate{connection="10.0.0.2:6379",connection_id="conn-2",engine="vllm-b",model="qwen"} 0.3');
  });

  it('clears KV cache series for every connection', async () => {
    service.setKvCacheFootprint('conn-1', [footprint('llama', 10, 1000)]);
    service.setKvCacheHitRates('conn-1', [{ engine: 'vllm-a', model: 'llama', hitRate: 0.5 }]);
    service.setKvCacheFootprint('conn-2', [footprint('qwen', 4, 400)]);
    service.clearAllKvCache();
    const text = await exposition();
    expect(text).not.toContain('betterdb_kv_cache_chunks{');
    expect(text).not.toContain('betterdb_kv_cache_bytes{');
    expect(text).not.toContain('betterdb_kv_cache_hit_rate{');
  });

  it('clears KV cache series when the connection is cleaned up', async () => {
    service.setKvCacheFootprint('conn-1', [footprint('llama', 10, 1000)]);
    service.setKvCacheHitRates('conn-1', [{ engine: 'vllm-a', model: 'llama', hitRate: 0.5 }]);
    service.cleanupConnectionMetrics('conn-1');
    const text = await exposition();
    expect(text).not.toContain('betterdb_kv_cache_chunks{');
    expect(text).not.toContain('betterdb_kv_cache_hit_rate{');
  });

  it('keeps the series of connections that share a host:port label apart', async () => {
    service.setKvCacheFootprint('agent-1', [footprint('llama', 10, 1000)]);
    service.setKvCacheHitRates('agent-1', [{ engine: 'vllm', model: 'llama', hitRate: 0.5 }]);
    service.setKvCacheFootprint('agent-2', [footprint('llama', 4, 400)]);
    service.setKvCacheHitRates('agent-2', [{ engine: 'vllm', model: 'llama', hitRate: 0.2 }]);
    service.clearKvCache('agent-2');
    const text = await exposition();
    expect(text).toContain('betterdb_kv_cache_chunks{connection="agent:0",connection_id="agent-1",model="llama"} 10');
    expect(text).toContain('betterdb_kv_cache_hit_rate{connection="agent:0",connection_id="agent-1",engine="vllm",model="llama"} 0.5');
    expect(text).not.toContain('connection_id="agent-2"');
  });

  it('ignores unknown connections', async () => {
    service.setKvCacheFootprint('missing', [footprint('llama', 10, 1000)]);
    service.setKvCacheHitRates('missing', [{ engine: 'a', model: 'm', hitRate: 0.1 }]);
    service.clearKvCache('missing');
    expect(await exposition()).not.toContain('betterdb_kv_cache_chunks{');
  });
});
