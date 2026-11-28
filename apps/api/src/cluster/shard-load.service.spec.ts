import { Logger } from '@nestjs/common';
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
    expect(service.getSlots('conn-a', 'n1')).toEqual([]);
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
    expect(service.getSlots('conn-a', 'n1')).toEqual([
      expect.objectContaining({ slot: 0, cpuUsecPerSecond: 500 }),
    ]);
    expect(service.getSlots('conn-b', 'n1')).toEqual([]);
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

  it('gives the median key count per slot of each connection', () => {
    const service = new ShardLoadService();

    expect(service.getMedianKeyCount('conn-a')).toBeNull();
    service.record('conn-a', reading({ 0: 0, 1: 0, 2: 0 }), 0);

    expect(service.getMedianKeyCount('conn-a')).toBe(1);
    service.forget('conn-a');
    expect(service.getMedianKeyCount('conn-a')).toBeNull();
  });

  it('says whether the last reading carried the usage counters', () => {
    const service = new ShardLoadService();
    expect(service.reportsUsage('conn-a')).toBeNull();

    service.record('conn-a', reading({ 0: 0 }), 0);
    expect(service.reportsUsage('conn-a')).toBe(true);

    service.record(
      'conn-a',
      [{ nodeId: 'n1', address: '10.0.0.1:6379', stats: { 0: { key_count: 1 } } }],
      1_000,
    );
    expect(service.reportsUsage('conn-a')).toBe(false);

    service.forget('conn-a');
    expect(service.reportsUsage('conn-a')).toBeNull();
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

describe('ShardLoadService listeners and sustain minutes', () => {
  const CORE = 1_000_000;

  function listen(service: ShardLoadService) {
    const listener = { tracking: jest.fn(), sample: jest.fn(), reset: jest.fn() };
    const stop = service.addListener(listener);
    return { listener, stop };
  }

  function sustainAfter(service: ShardLoadService, connectionId: string, minutes: number) {
    let sample = null;
    for (let at = 0; at <= 5_000 + minutes * 60_000; at += 5_000) {
      const busySeconds = Math.max(0, at / 1000 - 5);
      sample = service.record(connectionId, reading({ 0: CORE * busySeconds }), at) ?? sample;
    }
    return sample?.shards[0].sustainCpuUsecPerSecond ?? 0;
  }

  const expected = (sustainMinutes: number, minutes: number) =>
    CORE * (1 - Math.exp(-minutes / (sustainMinutes / 3)));

  it('tells a listener when a connection starts tracking and hands it every sample', () => {
    const service = new ShardLoadService();
    const { listener } = listen(service);
    service.record('conn-a', reading({ 0: 0 }), 0);
    const sample = service.record('conn-a', reading({ 0: 500 }), 1_000);
    service.record('conn-a', reading({ 0: 900 }), 2_000);

    expect(listener.tracking).toHaveBeenCalledTimes(1);
    expect(listener.tracking).toHaveBeenCalledWith('conn-a');
    expect(listener.sample).toHaveBeenCalledTimes(2);
    expect(listener.sample).toHaveBeenNthCalledWith(1, 'conn-a', sample);
    expect(listener.reset).not.toHaveBeenCalled();
  });

  it('tells a listener when the tracker resets, and once only', () => {
    const service = new ShardLoadService();
    const { listener } = listen(service);
    const untracked = [{ nodeId: 'n1', address: '10.0.0.1:6379', stats: { 0: { key_count: 1 } } }];
    service.record('conn-a', reading({ 0: 0 }), 0);
    service.record('conn-a', reading({ 0: 500 }), 1_000);

    service.record('conn-a', untracked, 2_000);
    service.record('conn-a', untracked, 3_000);

    expect(listener.reset).toHaveBeenCalledTimes(1);
    expect(listener.reset).toHaveBeenCalledWith('conn-a');
  });

  it('tells a listener each time tracking starts, and not for a reading that cannot track', () => {
    const service = new ShardLoadService();
    const { listener } = listen(service);
    const untracked = [{ nodeId: 'n1', address: '10.0.0.1:6379', stats: { 0: { key_count: 1 } } }];
    service.record('conn-a', untracked, 0);
    expect(listener.tracking).not.toHaveBeenCalled();

    service.record('conn-a', reading({ 0: 0 }), 1_000);
    service.record('conn-a', untracked, 2_000);
    service.record('conn-a', reading({ 0: 0 }), 3_000);

    expect(listener.tracking).toHaveBeenCalledTimes(2);
  });

  it('tells a listener when a connection is forgotten or removed', () => {
    const service = new ShardLoadService();
    const { listener } = listen(service);

    service.forget('conn-a');
    service.remove('conn-b');

    expect(listener.reset.mock.calls).toEqual([['conn-a'], ['conn-b']]);
  });

  it('keeps calling the other listeners when one throws, and stops calling a removed one', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new ShardLoadService();
    const failing = listen(service);
    failing.listener.sample.mockImplementation(() => {
      throw new Error('boom');
    });
    const { listener, stop } = listen(service);
    service.record('conn-a', reading({ 0: 0 }), 0);
    service.record('conn-a', reading({ 0: 500 }), 1_000);
    expect(listener.sample).toHaveBeenCalledTimes(1);

    stop();
    service.record('conn-a', reading({ 0: 900 }), 2_000);
    expect(listener.sample).toHaveBeenCalledTimes(1);
  });

  it('applies sustain minutes set before the tracker exists', () => {
    const service = new ShardLoadService();
    service.setSustainMinutes('conn-a', 60);

    expect(sustainAfter(service, 'conn-a', 10)).toBeCloseTo(expected(60, 10), -3);
  });

  it('keeps the sustain minutes through forget, and drops them on remove', () => {
    const service = new ShardLoadService();
    service.setSustainMinutes('conn-a', 60);
    sustainAfter(service, 'conn-a', 1);

    service.forget('conn-a');
    expect(sustainAfter(service, 'conn-a', 10)).toBeCloseTo(expected(60, 10), -3);

    service.remove('conn-a');
    expect(sustainAfter(service, 'conn-a', 10)).toBeCloseTo(expected(30, 10), -3);
  });
});
