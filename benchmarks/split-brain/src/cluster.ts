import { IMAGE, LABEL, type LaneSpec, type NodeSpec, VALKEY_PORT, sleep } from './config';
import { docker, removeContainers, rootExec } from './docker';
import { command } from './resp';

export interface ViewLine {
  id: string;
  address: string;
  flags: string[];
  primaryId: string;
  configEpoch: number;
  link: string;
  slots: string;
}

export function parseView(raw: string): ViewLine[] {
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(' ');
      return {
        id: parts[0],
        address: parts[1],
        flags: parts[2].split(','),
        primaryId: parts[3],
        configEpoch: Number(parts[6]),
        link: parts[7],
        slots: parts.slice(8).join(' '),
      };
    });
}

export function ownedSlots(raw: string): number {
  const own = parseView(raw).find((line) => line.flags.includes('myself'));
  if (!own) return 0;
  return own.slots
    .split(' ')
    .filter((part) => part !== '' && !part.startsWith('['))
    .reduce((total, part) => {
      const [first, last = first] = part.split('-').map(Number);
      return total + last - first + 1;
    }, 0);
}

function storyOf(raw: string): string {
  return parseView(raw)
    .map((line) => {
      const flags = line.flags.filter((flag) => flag !== 'myself').sort().join(',');
      return `${line.id} ${flags} ${line.primaryId} ${line.configEpoch} ${line.slots}`;
    })
    .sort()
    .join('\n');
}

export async function readViews(nodes: NodeSpec[], timeoutMs = 1_500): Promise<Array<string | null>> {
  return Promise.all(
    nodes.map((node) =>
      command(node.hostPort, ['CLUSTER', 'NODES'], timeoutMs).then(
        (reply) => String(reply),
        () => null,
      ),
    ),
  );
}

const UNSETTLED_FLAGS = ['fail', 'fail?', 'handshake', 'noaddr', 'nofailover'];

export function agreed(views: Array<string | null>, members: number): boolean {
  if (views.some((view) => view === null)) return false;
  const texts = views as string[];
  for (const text of texts) {
    const lines = parseView(text);
    if (lines.length !== members) return false;
    for (const line of lines) {
      if (line.flags.some((flag) => UNSETTLED_FLAGS.includes(flag))) return false;
      if (!line.flags.includes('myself') && line.link !== 'connected') return false;
    }
  }
  const first = storyOf(texts[0]);
  return texts.every((text) => storyOf(text) === first);
}

export async function waitAgreed(
  nodes: NodeSpec[],
  members: number,
  timeoutMs: number,
  stableChecks = 2,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const views = await readViews(nodes);
    const states = await Promise.all(
      nodes.map((node) =>
        command(node.hostPort, ['CLUSTER', 'INFO'], 1_500).then(
          (reply) => /cluster_state:ok/.test(String(reply)),
          () => false,
        ),
      ),
    );
    stable = agreed(views, members) && states.every(Boolean) ? stable + 1 : 0;
    if (stable >= stableChecks) return true;
    await sleep(500);
  }
  return false;
}

export async function ensureNetwork(lane: LaneSpec): Promise<void> {
  const existing = await docker(['network', 'ls', '--filter', `name=^${lane.network}$`, '--format', '{{.Name}}']);
  if (existing === lane.network) return;
  await docker([
    'network',
    'create',
    '--driver',
    'bridge',
    '--subnet',
    lane.subnet,
    '--label',
    LABEL,
    lane.network,
  ]);
}

export async function startNode(lane: LaneSpec, node: NodeSpec, nodeTimeoutMs: number): Promise<void> {
  await docker([
    'run',
    '-d',
    '--name',
    node.container,
    '--label',
    LABEL,
    '--network',
    lane.network,
    '--ip',
    node.ip,
    '-p',
    `127.0.0.1:${node.hostPort}:${VALKEY_PORT}`,
    '--cap-add',
    'NET_ADMIN',
    IMAGE,
    'valkey-server',
    '--port',
    String(VALKEY_PORT),
    '--bind',
    '0.0.0.0',
    '--protected-mode',
    'no',
    '--cluster-enabled',
    'yes',
    '--cluster-config-file',
    'nodes.conf',
    '--cluster-node-timeout',
    String(nodeTimeoutMs),
    '--availability-zone',
    node.zone,
    '--appendonly',
    'no',
    '--save',
    '',
  ]);
}

export async function waitAnswering(nodes: NodeSpec[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pongs = await Promise.all(
      nodes.map((node) =>
        command(node.hostPort, ['PING'], 1_000).then(
          (reply) => reply === 'PONG',
          () => false,
        ),
      ),
    );
    if (pongs.every(Boolean)) return;
    if (Date.now() > deadline) throw new Error('nodes did not start answering');
    await sleep(200);
  }
}

export async function nodeId(node: NodeSpec): Promise<string> {
  return String(await command(node.hostPort, ['CLUSTER', 'MYID']));
}

function slotRangesFor(shard: number, shards: number): [number, number] {
  const start = Math.floor((16384 * shard) / shards);
  const end = Math.floor((16384 * (shard + 1)) / shards) - 1;
  return [start, end];
}

export interface BuiltCluster {
  ids: Record<string, string>;
  slots: Record<string, [number, number]>;
  buildMs: number;
}

export async function createCluster(lane: LaneSpec, nodeTimeoutMs: number): Promise<BuiltCluster> {
  const startedAt = Date.now();
  await removeContainers(`sbb-l${lane.lane}-`);
  await ensureNetwork(lane);
  await Promise.all(lane.nodes.map((node) => startNode(lane, node, nodeTimeoutMs)));
  await waitAnswering(lane.nodes, 30_000);

  const primaries = lane.nodes.filter((node) => node.role === 'primary');
  const slots: Record<string, [number, number]> = {};
  await Promise.all(
    lane.nodes.map((node, index) =>
      command(node.hostPort, ['CLUSTER', 'SET-CONFIG-EPOCH', String(index + 1)]),
    ),
  );
  await Promise.all(
    primaries.map((node, shard) => {
      const [start, end] = slotRangesFor(shard, primaries.length);
      slots[node.name] = [start, end];
      return command(node.hostPort, ['CLUSTER', 'ADDSLOTSRANGE', String(start), String(end)]);
    }),
  );
  const [seed, ...others] = lane.nodes;
  await Promise.all(
    others.map((node) => command(seed.hostPort, ['CLUSTER', 'MEET', node.ip, String(VALKEY_PORT)])),
  );

  const ids: Record<string, string> = {};
  for (const node of lane.nodes) ids[node.name] = await nodeId(node);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const views = await readViews(lane.nodes);
    const known = views.every((view) => {
      if (view === null) return false;
      const lines = parseView(view);
      return lines.length === lane.nodes.length && lines.every((line) => !line.flags.includes('handshake'));
    });
    if (known) break;
    if (Date.now() > deadline) throw new Error('nodes did not meet');
    await sleep(250);
  }

  for (const node of lane.nodes) {
    if (node.role !== 'replica' || !node.primary) continue;
    const primaryId = ids[node.primary];
    for (let attempt = 0; ; attempt++) {
      try {
        await command(node.hostPort, ['CLUSTER', 'REPLICATE', primaryId]);
        break;
      } catch (err) {
        if (attempt >= 20) throw err;
        await sleep(250);
      }
    }
  }

  if (!(await waitAgreed(lane.nodes, lane.nodes.length, 60_000))) {
    throw new Error('cluster did not converge');
  }
  return { ids, slots, buildMs: Date.now() - startedAt };
}

export async function detectIptables(container: string): Promise<string> {
  for (const binary of ['iptables', 'iptables-legacy']) {
    try {
      await rootExec(container, `${binary} -L INPUT -n >/dev/null`);
      return binary;
    } catch {
      continue;
    }
  }
  throw new Error('no working iptables in the node image');
}
