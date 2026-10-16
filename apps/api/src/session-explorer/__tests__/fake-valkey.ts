import type Valkey from 'iovalkey';
import type { DatabasePort } from '../../common/interfaces/database-port.interface';
import type { ClusterNode } from '../../common/types/metrics.types';

export interface FakeEntry {
  type: string;
  pttl?: number;
  memory?: number | null;
  idle?: number;
  value?: string | Buffer | Array<string | Buffer> | Record<string, string | Buffer>;
}

const WRITE_COMMANDS = [
  'set',
  'del',
  'expire',
  'persist',
  'unlink',
  'hset',
  'lpush',
  'keys',
  'flushall',
  'flushdb',
];

const WRITE_CALLS = ['JSON.SET', 'JSON.DEL', 'SET', 'DEL', 'EXPIRE', 'PERSIST', 'UNLINK', 'KEYS'];

export class FakeValkey {
  calls: Array<{ name: string; args: unknown[] }> = [];
  pipelineExecs = 0;
  scanPages?: string[][];
  connectError?: Error;
  disconnected = false;
  options: Record<string, unknown>;

  constructor(
    public store: Map<string, FakeEntry> = new Map(),
    options: Record<string, unknown> = { host: 'seed', port: 7000 },
  ) {
    this.options = options;
    for (const name of WRITE_COMMANDS) {
      (this as unknown as Record<string, unknown>)[name] = () => {
        throw new Error(`write command ${name} issued`);
      };
    }
  }

  private record(name: string, args: unknown[]) {
    this.calls.push({ name, args });
  }

  callsOf(name: string) {
    return this.calls.filter((c) => c.name === name);
  }

  on() {
    return this;
  }

  async connect() {
    this.record('connect', []);
    if (this.connectError) throw this.connectError;
  }

  disconnect() {
    this.disconnected = true;
  }

  async quit() {
    this.disconnected = true;
    return 'OK';
  }

  async scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
    this.record('scan', [cursor, ...args]);
    if (this.scanPages) {
      const index = Number(cursor);
      const page = this.scanPages[index] ?? [];
      const next = index + 1 < this.scanPages.length ? String(index + 1) : '0';
      return [next, page];
    }
    return ['0', [...this.store.keys()]];
  }

  private entry(key: string) {
    return this.store.get(key);
  }

  private meta(name: string, key: string): unknown {
    const e = this.entry(key);
    switch (name) {
      case 'type':
        return e ? e.type : 'none';
      case 'pttl':
        return e ? (e.pttl ?? -1) : -2;
      case 'memory':
        return e ? (e.memory === undefined ? 100 : e.memory) : null;
      case 'object':
        if (!e) throw new Error('ERR no such key');
        return e.idle ?? 0;
      case 'strlen':
        return e ? Buffer.from(e.value as string | Buffer).length : 0;
      case 'llen':
        return e ? (e.value as unknown[]).length : 0;
      case 'hlen':
        return e ? Object.keys(e.value as object).length : 0;
      case 'zcard':
        return e ? (e.value as unknown[]).length / 2 : 0;
      default:
        throw new Error(`unexpected pipeline command ${name}`);
    }
  }

  pipeline() {
    const ops: Array<{ name: string; key: string }> = [];
    const chain: Record<string, unknown> = {};
    const add =
      (name: string) =>
      (...args: unknown[]) => {
        const key = (name === 'memory' || name === 'object' ? args[1] : args[0]) as string;
        this.record(`pipeline.${name}`, args);
        ops.push({ name, key });
        return chain;
      };
    for (const name of ['type', 'pttl', 'memory', 'object', 'strlen', 'llen', 'hlen', 'zcard']) {
      chain[name] = add(name);
    }
    for (const name of WRITE_COMMANDS) {
      chain[name] = () => {
        throw new Error(`write command ${name} issued in pipeline`);
      };
    }
    chain.exec = async () => {
      this.pipelineExecs++;
      return ops.map(({ name, key }) => {
        try {
          return [null, this.meta(name, key)];
        } catch (err) {
          return [err, null];
        }
      });
    };
    return chain;
  }

  async type(key: string) {
    this.record('type', [key]);
    return this.meta('type', key);
  }

  async strlen(key: string) {
    this.record('strlen', [key]);
    return this.meta('strlen', key);
  }

  async llen(key: string) {
    this.record('llen', [key]);
    return this.meta('llen', key);
  }

  async getBuffer(key: string) {
    this.record('getBuffer', [key]);
    const e = this.entry(key);
    return e ? Buffer.from(e.value as string | Buffer) : null;
  }

  async getrangeBuffer(key: string, start: number, end: number) {
    this.record('getrangeBuffer', [key, start, end]);
    const e = this.entry(key);
    return e ? Buffer.from(e.value as string | Buffer).subarray(start, end + 1) : Buffer.alloc(0);
  }

  async lrangeBuffer(key: string, start: number, stop: number) {
    this.record('lrangeBuffer', [key, start, stop]);
    const e = this.entry(key);
    const items = (e?.value as Array<string | Buffer>) ?? [];
    return items.slice(start, stop + 1).map((v) => Buffer.from(v));
  }

  async hgetallBuffer(key: string) {
    this.record('hgetallBuffer', [key]);
    const e = this.entry(key);
    return Object.fromEntries(
      Object.entries((e?.value as Record<string, string>) ?? {}).map(([k, v]) => [k, Buffer.from(v)]),
    );
  }

  async hscanBuffer(key: string, cursor: string, ...args: unknown[]) {
    this.record('hscanBuffer', [key, cursor, ...args]);
    const e = this.entry(key);
    const flat = Object.entries((e?.value as Record<string, string>) ?? {}).flatMap(([k, v]) => [
      Buffer.from(k),
      Buffer.from(v),
    ]);
    return [Buffer.from('0'), flat];
  }

  async zrangeBuffer(key: string, start: number, stop: string, ...args: unknown[]) {
    this.record('zrangeBuffer', [key, start, stop, ...args]);
    const e = this.entry(key);
    const flat = (e?.value as string[]) ?? [];
    return flat.slice(start * 2, (Number(stop) + 1) * 2).map((v) => Buffer.from(v));
  }

  async callBuffer(command: string, ...args: unknown[]) {
    this.record(`call:${command}`, args);
    if (WRITE_CALLS.includes(command.toUpperCase())) {
      throw new Error(`write command ${command} issued`);
    }
    if (command.toUpperCase() === 'JSON.GET') {
      const e = this.entry(args[0] as string);
      return e ? Buffer.from(e.value as string) : null;
    }
    throw new Error(`unexpected call ${command}`);
  }

  async call(command: string, ...args: unknown[]) {
    return this.callBuffer(command, ...args);
  }
}

export function masterNode(id: string, address: string, extraFlags: string[] = []): ClusterNode {
  return {
    id,
    address: `${address}@17000`,
    flags: ['master', ...extraFlags],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 0,
    linkState: 'connected',
    slots: [[0, 100]],
  };
}

export function fakeDb(
  parent: FakeValkey,
  cluster?: { nodes: ClusterNode[] },
): DatabasePort {
  return {
    getClient: () => parent as unknown as Valkey,
    getCapabilities: () => ({ clusterEnabled: cluster !== undefined }),
    getClusterNodes: async () => cluster?.nodes ?? [],
  } as unknown as DatabasePort;
}
