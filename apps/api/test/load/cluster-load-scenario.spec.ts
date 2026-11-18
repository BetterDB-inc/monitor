import { appFrame } from '../../scripts/cluster-load/call-site';
import { downOutsideHung, hangLimit, pickHungNodes } from '../../scripts/cluster-load/hung-nodes';
import { PassRecorder } from '../../scripts/cluster-load/pass-recorder';
import { pauseChecking } from '../../scripts/cluster-load/pause';
import { pollerResult } from '../../scripts/cluster-load/poller-result';

const HOST = '127.0.0.1';

const clusterOf = (shards: number, replicasPerShard: number) =>
  Array.from({ length: shards * (1 + replicasPerShard) }, (_, index) => ({
    index,
    host: HOST,
    port: 7000 + index,
    shard: Math.floor(index / (1 + replicasPerShard)),
  }));

const connectionTo = (node: { host: string; port: number }, isConnected: boolean) => ({
  host: node.host,
  port: node.port,
  isConnected,
});

describe('cluster load test, hung nodes', () => {
  it('hangs the last nodes of the cluster', () => {
    expect(pickHungNodes(clusterOf(3, 1), 2, null)).toEqual([5, 4]);
  });

  it('never hangs the seed node', () => {
    expect(pickHungNodes(clusterOf(2, 1), 3, null)).toEqual([3, 2, 1]);
    expect(() => pickHungNodes(clusterOf(2, 1), 4, null)).toThrow('4 nodes to hang');
  });

  it('leaves the shard of the failover alone', () => {
    expect(pickHungNodes(clusterOf(2, 1), 1, 1)).toEqual([1]);
    expect(pickHungNodes(clusterOf(3, 1), 2, 1)).toEqual([5, 4]);
    expect(pickHungNodes(clusterOf(3, 1), 3, 1)).toEqual([5, 4, 1]);
  });

  it('refuses more hung nodes than the failover leaves', () => {
    expect(() => pickHungNodes(clusterOf(2, 1), 2, 1)).toThrow('2 nodes to hang');
  });

  it('counts how many nodes can hang', () => {
    expect(hangLimit(4, 2, false)).toBe(3);
    expect(hangLimit(4, 2, true)).toBe(1);
    expect(hangLimit(100, 2, true)).toBe(97);
  });
});

describe('cluster load test, connections down at the end', () => {
  const nodes = clusterOf(3, 1);

  it('counts a dropped seed connection although a node was made to hang', () => {
    const hung = [nodes[5]];
    expect(downOutsideHung([connectionTo(nodes[0], false)], hung)).toBe(1);
  });

  it('counts nothing while the seed connection is up', () => {
    expect(downOutsideHung([connectionTo(nodes[0], true)], [nodes[5]])).toBe(0);
  });

  it('counts a healthy connection that is down with every node registered', () => {
    const hung = [nodes[5], nodes[4]];
    const connections = nodes.map((node) => connectionTo(node, node.index !== 2));
    expect(downOutsideHung(connections, hung)).toBe(1);
  });

  it('leaves out the connections to the hung nodes with every node registered', () => {
    const hung = [nodes[5], nodes[4]];
    const connections = nodes.map((node) => connectionTo(node, node.index < 4));
    expect(downOutsideHung(connections, hung)).toBe(0);
  });
});

describe('cluster load test, pass times', () => {
  const pass = (durations: number[]) => pollerResult({ durations, commands: 0 }, 1000, 0, 120);

  it('reads p50 of two passes between them', () => {
    expect(pass([200, 100]).p50Ms).toBe(150);
  });

  it('reads p95 of twenty passes below the slowest', () => {
    const durations = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);
    const result = pass(durations);
    expect(result.p95Ms).toBe(190.5);
    expect(result.maxMs).toBe(200);
  });

  it('reports the passes done, the passes an idle poller would do and the commands', () => {
    expect(pollerResult({ durations: [100, 100, 100, 100], commands: 480 }, 1000, 480, 120)).toEqual({
      intervalMs: 1000,
      ticks: 4,
      expectedTicks: 120,
      p50Ms: 100,
      p95Ms: 100,
      maxMs: 100,
      commandsPerTick: 120,
      commandsPerSecond: 4,
    });
  });

  it('reports zeros for a poller without a pass', () => {
    expect(pollerResult({ durations: [], commands: 0 }, 0, 0, 120)).toEqual({
      intervalMs: 0,
      ticks: 0,
      expectedTicks: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      commandsPerTick: 0,
      commandsPerSecond: 0,
    });
  });
});

describe('cluster load test, passes in the window', () => {
  const POLLER = 'AnomalyService';
  let recorder: PassRecorder;

  beforeEach(() => {
    recorder = new PassRecorder();
    recorder.track(POLLER);
  });

  it('leaves out a pass that began before the window', () => {
    const early = recorder.begin(POLLER, 100);
    early.commands += 5;
    recorder.startWindow(200);
    early.commands += 3;
    recorder.end(early, 9200);
    const inside = recorder.begin(POLLER, 9300);
    inside.commands += 7;
    recorder.end(inside, 9550);
    expect(recorder.totals().get(POLLER)).toEqual({ durations: [250], commands: 7 });
  });

  it('leaves out a pass that has not ended', () => {
    recorder.startWindow(200);
    const done = recorder.begin(POLLER, 300);
    done.commands += 4;
    recorder.end(done, 400);
    recorder.begin(POLLER, 500).commands += 9;
    expect(recorder.totals().get(POLLER)).toEqual({ durations: [100], commands: 4 });
  });

  it('counts the commands a pass sends after it ended', () => {
    recorder.startWindow(200);
    const pass = recorder.begin(POLLER, 300);
    pass.commands += 4;
    recorder.end(pass, 400);
    pass.commands += 2;
    expect(recorder.totals().get(POLLER)).toEqual({ durations: [100], commands: 6 });
  });

  it('forgets the passes of the warm-up', () => {
    const warmup = recorder.begin(POLLER, 100);
    recorder.end(warmup, 150);
    recorder.startWindow(200);
    expect(recorder.totals().get(POLLER)).toEqual({ durations: [], commands: 0 });
  });

  it('divides the commands of the counted passes by those passes', () => {
    const result = pollerResult({ durations: [100, 100], commands: 60 }, 1000, 90, 10);
    expect(result.commandsPerTick).toBe(30);
    expect(result.commandsPerSecond).toBe(9);
  });
});

describe('cluster load test, pauses', () => {
  it('waits for the time given', async () => {
    const started = Date.now();
    await pauseChecking(40, () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(39);
  });

  it('fails at once when the check already fails', async () => {
    const started = Date.now();
    const check = (): void => {
      throw new Error('out of ports');
    };
    await expect(pauseChecking(5000, check)).rejects.toThrow('out of ports');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('fails when the check starts to fail during the last sleep', async () => {
    let failing = false;
    setTimeout(() => {
      failing = true;
    }, 10);
    const check = (): void => {
      if (failing) throw new Error('out of ports');
    };
    await expect(pauseChecking(60, check)).rejects.toThrow('out of ports');
  });
});

describe('cluster load test, call sites', () => {
  const FRAME = 'cluster-discovery.service: ClusterDiscoveryService.readNodes';

  it('names the file and function of an app frame', () => {
    const line = '    at ClusterDiscoveryService.readNodes (/repo/apps/api/src/cluster/cluster-discovery.service.ts:41:17)';
    expect(appFrame(line)).toBe(FRAME);
  });

  it('names an async frame of the proprietary code', () => {
    const line = '    at async AnomalyService.pollConnection (/repo/proprietary/anomaly/anomaly.service.ts:9:3)';
    expect(appFrame(line)).toBe('anomaly.service: AnomalyService.pollConnection');
  });

  it('reads a frame with Windows separators', () => {
    const line =
      '    at ClusterDiscoveryService.readNodes (C:\\repo\\apps\\api\\src\\cluster\\cluster-discovery.service.ts:41:17)';
    expect(appFrame(line)).toBe(FRAME);
  });

  it('skips the database adapters on either separator', () => {
    const posix = '    at ValkeyAdapter.call (/repo/apps/api/src/database/adapters/valkey.adapter.ts:5:1)';
    const windows = '    at ValkeyAdapter.call (C:\\repo\\apps\\api\\src\\database\\adapters\\valkey.adapter.ts:5:1)';
    expect(appFrame(posix)).toBeNull();
    expect(appFrame(windows)).toBeNull();
  });

  it('skips frames outside the app', () => {
    expect(appFrame('    at Valkey.sendCommand (/repo/node_modules/iovalkey/built/Redis.js:1:1)')).toBeNull();
  });
});
