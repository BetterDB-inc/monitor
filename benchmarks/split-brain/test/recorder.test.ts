import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { type NodeSpec, PROBE_TIMEOUT_MS, laneSpec } from '../src/config';
import { ownedSlots } from '../src/cluster';
import { Probe } from '../src/recorder';
import { recordedWith } from '../src/trace';
import type { TrialMeta } from '../src/scenarios';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a sample that started later keeps its own full time limit', async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const node = { name: 'n1', hostPort: (server.address() as net.AddressInfo).port } as NodeSpec;
  const probe = new Probe(node);
  try {
    const first = probe.sample();
    await wait(1_000);
    const second = await probe.sample();
    assert.equal((await first).ok, false);
    assert.equal(second.ok, false);
    assert.ok(second.lat >= PROBE_TIMEOUT_MS - 100, `the second sample ended after ${second.lat} ms`);
  } finally {
    probe.close();
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

test('lanes never share a host port, whatever the cluster size', () => {
  for (const size of [6, 12, 30]) {
    const ports = [0, 1, 2, 3].flatMap((lane) => {
      const spec = laneSpec(lane, size);
      return [...spec.nodes, spec.joiner].map((node) => node.hostPort);
    });
    assert.equal(new Set(ports).size, ports.length, `size ${size}`);
  }
  assert.deepEqual(laneSpec(1, 6).nodes.map((node) => node.hostPort), [7311, 7312, 7313, 7314, 7315, 7316]);
  assert.throws(() => laneSpec(0, 7), /even/);
});

test('owned slots are counted from the node\'s own line without migration markers', () => {
  const view = [
    'a 10.0.0.1:6379@16379 myself,master - 0 0 1 connected 0-99 200 300-301 [400->-b]',
    'b 10.0.0.2:6379@16379 master - 0 0 2 connected 100-199',
  ].join('\n');
  assert.equal(ownedSlots(view), 103);
  assert.equal(ownedSlots('b 10.0.0.2:6379@16379 myself,slave a 0 0 2 connected'), 0);
});

test('a resume is refused when a recorded trial used another setup', () => {
  const members = new Array(6).fill({ role: 'primary' });
  const meta = { nodeTimeoutMs: 5_000, nodes: members } as TrialMeta;
  const joined = { nodeTimeoutMs: 5_000, nodes: [...members, { role: 'joiner' }] } as TrialMeta;
  assert.equal(recordedWith(meta, { nodeTimeoutMs: 5_000, clusterSize: 6 }), null);
  assert.equal(recordedWith(joined, { nodeTimeoutMs: 5_000, clusterSize: 6 }), null);
  assert.match(recordedWith(meta, { nodeTimeoutMs: 15_000, clusterSize: 6 }) ?? '', /5000 ms, not 15000 ms/);
  assert.match(recordedWith(meta, { nodeTimeoutMs: 5_000, clusterSize: 12 }) ?? '', /6 nodes, not 12/);
  assert.match(recordedWith(joined, { nodeTimeoutMs: 5_000, clusterSize: 12 }) ?? '', /6 nodes, not 12/);
});
