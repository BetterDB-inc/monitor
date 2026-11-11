import { NodeSlotStats } from './shard-load';
import { ShardLoadService } from './shard-load.service';

function reading(cpuBySlot: Record<number, number>, nodeId = 'n1'): NodeSlotStats[] {
  const stats = Object.fromEntries(
    Object.entries(cpuBySlot).map(([slot, cpu]) => [
      slot,
      { key_count: 1, cpu_usec: cpu, network_bytes_in: 0, network_bytes_out: 0 },
    ]),
  );
  return [{ nodeId, address: '10.0.0.1:6379', stats }];
}

describe('ShardLoadService', () => {
  it('has nothing for a connection it has not measured', () => {
    const service = new ShardLoadService();

    expect(service.getLatest('conn-a')).toBeNull();
    expect(service.getTopSlots('conn-a', 'n1', 5)).toEqual([]);
  });

  it('keeps the latest sample of each connection apart', () => {
    const service = new ShardLoadService();
    service.record('conn-a', reading({ 0: 0 }), 0);
    service.record('conn-b', reading({ 0: 0 }), 0);

    const sample = service.record('conn-a', reading({ 0: 500 }), 1_000);

    expect(sample?.shards[0].cpuUsecPerSecond).toBe(500);
    expect(service.getLatest('conn-a')).toBe(sample);
    expect(service.getLatest('conn-b')).toBeNull();
    expect(service.getTopSlots('conn-a', 'n1', 5)).toEqual([expect.objectContaining({ slot: 0 })]);
  });

  it('keeps the last sample across a reading that adds nothing', () => {
    const service = new ShardLoadService();
    service.record('conn-a', reading({ 0: 0 }), 0);
    const sample = service.record('conn-a', reading({ 0: 500 }), 1_000);

    service.record('conn-a', reading({ 0: 900 }), 1_000);

    expect(service.getLatest('conn-a')).toBe(sample);
  });

  it('drops the sample when the cluster stops tracking usage', () => {
    const service = new ShardLoadService();
    service.record('conn-a', reading({ 0: 0 }), 0);
    service.record('conn-a', reading({ 0: 500 }), 1_000);

    service.record(
      'conn-a',
      [{ nodeId: 'n1', address: '10.0.0.1:6379', stats: { 0: { key_count: 1 } } }],
      2_000,
    );

    expect(service.getLatest('conn-a')).toBeNull();
  });

  it('forgets a connection', () => {
    const service = new ShardLoadService();
    service.record('conn-a', reading({ 0: 0 }), 0);
    service.record('conn-a', reading({ 0: 500 }), 1_000);

    service.forget('conn-a');

    expect(service.getLatest('conn-a')).toBeNull();
    expect(service.record('conn-a', reading({ 0: 900 }), 2_000)).toBeNull();
  });
});
