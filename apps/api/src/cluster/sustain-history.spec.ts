import type { ShardLoad, ShardLoadSample } from './shard-load';
import { SustainHistory } from './sustain-history';

function shard(nodeId: string, sustain: number, slotCount = 10): ShardLoad {
  return {
    nodeId,
    address: `${nodeId}:6379`,
    slotCount,
    measuredSlots: slotCount,
    cpuUsecPerSecond: sustain,
    sustainCpuUsecPerSecond: sustain,
    baselineCpuUsecPerSecond: sustain,
    networkBytesInPerSecond: 0,
    networkBytesOutPerSecond: 0,
    cpuShare: null,
    networkShare: null,
  };
}

function sample(timestamp: number, shards: ShardLoad[], settling = false): ShardLoadSample {
  return { timestamp, shards, settling };
}

describe('SustainHistory', () => {
  it('records the sustain load, the median and the share of each shard', () => {
    const history = new SustainHistory();
    history.record(sample(1_000, [shard('a', 300), shard('b', 100), shard('c', 100)], true));

    expect(history.entries('a')).toEqual([
      {
        timestamp: 1_000,
        settling: true,
        sustainCpuUsecPerSecond: 300,
        medianSustainCpuUsecPerSecond: 100,
        sustainShare: 0.6,
      },
    ]);
  });

  it('drops entries older than the sustain minutes, whatever the poll interval', () => {
    const history = new SustainHistory();
    history.setSustainMinutes(10);
    for (let minute = 0; minute <= 30; minute += 1) {
      history.record(sample(minute * 60_000, [shard('a', 1), shard('b', 1), shard('c', 1)]));
    }

    expect(history.entries('a').map((entry) => entry.timestamp / 60_000)).toEqual([
      20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
  });

  it('forgets a shard that no longer owns slots', () => {
    const history = new SustainHistory();
    history.record(sample(1_000, [shard('a', 1), shard('b', 1)]));
    history.record(sample(2_000, [shard('a', 1), shard('b', 1, 0)]));

    expect(history.entries('b')).toEqual([]);
    expect(history.entries('a')).toHaveLength(2);
  });
});
