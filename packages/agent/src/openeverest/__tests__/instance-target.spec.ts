// Drives one InstanceTarget with a fake Kubernetes API (the connection
// Secret), a fake Valkey (discovery) and a fake Agent, to check the reconcile
// loop's timing: wake-ups during a reconcile, prompt stop, node metadata
// refresh and bounded start concurrency.

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
};

const agentState = {
  starts: [] as FakeAgent[],
  startGate: null as Gate | null,
  inFlight: 0,
  maxInFlight: 0,
};

class FakeAgent {
  stopped = false;
  constructor(readonly config: { valkeyHost: string; valkeyPort: number; identity: { node: string; nodeName?: string } }) {}
  async start(): Promise<void> {
    agentState.starts.push(this);
    agentState.inFlight += 1;
    agentState.maxInFlight = Math.max(agentState.maxInFlight, agentState.inFlight);
    if (agentState.startGate) await agentState.startGate.promise;
    agentState.inFlight -= 1;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  getStatus() {
    return { valkeyConnected: !this.stopped, cloudConnected: !this.stopped, valkeyVersion: '9.0.6', cluster: true };
  }
}

jest.mock('../../agent', () => ({ Agent: FakeAgent }));

const valkeyState = { shards: [] as unknown[] };

jest.mock('iovalkey', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    call: jest.fn(async (command: string, sub?: string) => {
      if (command === 'INFO' && sub === 'cluster') return 'cluster_enabled:1';
      if (command === 'CLUSTER' && sub === 'SHARDS') return valkeyState.shards;
      throw new Error(`unexpected ${command} ${sub}`);
    }),
  })),
}));

import { InstanceTarget } from '../instance-target';

const SECRET = {
  metadata: { name: 'orders-conn', namespace: 'db', resourceVersion: '1' },
  stringData: { host: 'valkey-orders.db.svc', port: '6379', username: 'default', password: 'p' },
};

class FakeKube {
  namespace = 'everest-system';
  async get() {
    return { metadata: { resourceVersion: '1' }, items: [SECRET] };
  }
  watch(_path: string, _rv: string | undefined, _onEvent: unknown, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }
}

function shard(id: string, role: 'master' | 'replica', index: number) {
  const host = `valkey-orders-${index}.valkey-orders.db.svc`;
  return ['slots', [0, 100], 'nodes', [['id', id, 'port', 6379, 'ip', `10.0.0.${index}`, 'endpoint', host, 'hostname', host, 'role', role, 'health', 'online']]];
}

function build(options: { startConcurrency?: number } = {}) {
  const logs: string[] = [];
  const target = new InstanceTarget({
    ref: { cluster: 'main', namespace: 'db', instance: 'orders' },
    kube: new FakeKube() as never,
    settings: () => ({ url: 'ws://monitor/api/agent/ws', token: 't' }),
    rediscoverIntervalMs: 60_000,
    log: (m) => logs.push(m),
    ...options,
  });
  return { target, logs };
}

// Lets the informer list, the reconcile run and any pending microtasks settle.
const settle = async () => {
  for (let i = 0; i < 20; i++) await jest.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  jest.useFakeTimers();
  agentState.starts = [];
  agentState.startGate = null;
  agentState.inFlight = 0;
  agentState.maxInFlight = 0;
  valkeyState.shards = [shard('aaa', 'master', 0)];
});

afterEach(() => {
  jest.useRealTimers();
});

describe('InstanceTarget reconcile loop', () => {
  it('serves a wake-up that arrives during a reconcile right after it, not after the next interval', async () => {
    const { target } = build();
    agentState.startGate = gate();
    target.setConnectionSecret('orders-conn');
    await settle();
    expect(agentState.starts).toHaveLength(1);

    target.onSettingsChanged();
    agentState.startGate.open();
    agentState.startGate = null;
    await settle();

    // A second agent came up with the new settings without the 60s timer firing.
    expect(agentState.starts).toHaveLength(2);
    expect(agentState.starts[0].stopped).toBe(true);
    expect(agentState.starts[1].stopped).toBe(false);
    await target.stop();
  });

  it('stops promptly when stop() lands in the middle of a reconcile', async () => {
    const { target } = build();
    agentState.startGate = gate();
    target.setConnectionSecret('orders-conn');
    await settle();

    const stopping = target.stop();
    agentState.startGate.open();
    agentState.startGate = null;
    await settle();
    await stopping;

    expect(agentState.starts).toHaveLength(1);
    expect(agentState.starts[0].stopped).toBe(true);
    expect(target.status().state).toBe('off');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refreshes a node\'s role in place after a failover instead of restarting its agent', async () => {
    const { target } = build();
    target.setConnectionSecret('orders-conn');
    await settle();
    expect(target.status().nodes.map((n) => n.role)).toEqual(['primary']);

    valkeyState.shards = [shard('aaa', 'replica', 0)];
    await jest.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(target.status().nodes.map((n) => n.role)).toEqual(['replica']);
    expect(agentState.starts).toHaveLength(1);
    expect(agentState.starts[0].stopped).toBe(false);
    await target.stop();
  });

  it('starts node agents a few at a time rather than one after another', async () => {
    valkeyState.shards = Array.from({ length: 6 }, (_, i) => shard(`node${i}`, 'master', i));
    const { target } = build({ startConcurrency: 3 });
    agentState.startGate = gate();
    target.setConnectionSecret('orders-conn');
    await settle();

    expect(agentState.inFlight).toBe(3);
    agentState.startGate.open();
    agentState.startGate = null;
    await settle();

    expect(agentState.starts).toHaveLength(6);
    expect(agentState.maxInFlight).toBe(3);
    expect(target.status().state).toBe('monitoring');
    expect(target.status().nodes).toHaveLength(6);
    await target.stop();
  });
});
