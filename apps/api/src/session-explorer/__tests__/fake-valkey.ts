import type Valkey from 'iovalkey';
import type { DatabasePort } from '../../common/interfaces/database-port.interface';
import type { ClusterNode } from '../../common/types/metrics.types';

export interface FakeEntry {
  type: string;
  pttl?: number;
  memory?: number | null;
  jsonMemory?: number | null;
  idle?: number;
  value?:
    | string
    | Buffer
    | Array<string | Buffer>
    | Record<string, string | Buffer>
    | Array<[string, Record<string, string>]>;
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

const READ_COMMANDS = [
  'type',
  'pttl',
  'memory',
  'object',
  'strlen',
  'llen',
  'zcard',
  'getBuffer',
  'getrangeBuffer',
  'lrangeBuffer',
  'hgetallBuffer',
  'hscanBuffer',
  'zrangeBuffer',
  'xrangeBuffer',
  'callBuffer',
  'call',
];

const KEY_INDEPENDENT = new Set(['memory', 'object']);

export class FakeValkey {
  calls: Array<{ name: string; args: unknown[] }> = [];
  pipelineExecs = 0;
  scanPages?: string[][];
  connectError?: Error;
  noTouchError?: Error;
  duplicateWith?: FakeValkey;
  disconnected = false;
  options: Record<string, unknown>;
  failKeys = new Map<string, string>();
  movedKeys = new Set<string>();

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
    for (const name of READ_COMMANDS) {
      (this as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        this.record(name, args);
        return this.run(name, args);
      };
    }
  }

  private record(name: string, args: unknown[]) {
    this.calls.push({ name, args });
  }

  callsOf(name: string) {
    return this.calls.filter((c) => c.name === name);
  }

  get directReads() {
    return this.calls.filter((c) => READ_COMMANDS.includes(c.name));
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

  duplicate(overrides: Record<string, unknown> = {}) {
    this.record('duplicate', [overrides]);
    if (!this.duplicateWith) throw new Error('duplicate unsupported');
    return this.duplicateWith;
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

  private keyOf(name: string, args: unknown[]): string {
    if (KEY_INDEPENDENT.has(name)) return args[1] as string;
    if (name === 'call' || name === 'callBuffer') {
      return (args[0] === 'JSON.DEBUG' ? args[2] : args[1]) as string;
    }
    return args[0] as string;
  }

  private run(name: string, args: unknown[]): unknown {
    const key = this.keyOf(name, args);
    if (this.movedKeys.has(key)) throw new Error('MOVED 1 10.0.0.9:7000');
    if (this.failKeys.has(key) && !['type', 'pttl', 'memory', 'object'].includes(name)) {
      throw new Error(this.failKeys.get(key));
    }
    const e = this.store.get(key);
    const raw = e?.value;
    switch (name) {
      case 'type':
        return e ? e.type : 'none';
      case 'pttl':
        return e ? (e.pttl ?? -1) : -2;
      case 'memory':
        if (e && e.memory === null) throw new Error('NOPERM memory');
        return e ? (e.memory ?? 100) : null;
      case 'object':
        if (!e) throw new Error('ERR no such key');
        return e.idle ?? 0;
      case 'strlen':
        return e ? Buffer.from(raw as string | Buffer).length : 0;
      case 'llen':
        return e ? (raw as unknown[]).length : 0;
      case 'zcard':
        return e ? (raw as unknown[]).length / 2 : 0;
      case 'getBuffer':
        return e ? Buffer.from(raw as string | Buffer) : null;
      case 'getrangeBuffer': {
        const [, start, end] = args as [string, number, number];
        return e ? Buffer.from(raw as string | Buffer).subarray(start, end + 1) : Buffer.alloc(0);
      }
      case 'lrangeBuffer': {
        const [, start, stop] = args as [string, number, number];
        return ((raw as Array<string | Buffer>) ?? []).slice(start, stop + 1).map((v) => Buffer.from(v));
      }
      case 'hgetallBuffer':
        return Object.fromEntries(
          Object.entries((raw as Record<string, string>) ?? {}).map(([k, v]) => [k, Buffer.from(v)]),
        );
      case 'hscanBuffer':
        return [
          Buffer.from('0'),
          Object.entries((raw as Record<string, string>) ?? {}).flatMap(([k, v]) => [
            Buffer.from(k),
            Buffer.from(v),
          ]),
        ];
      case 'zrangeBuffer': {
        const [, start, stop] = args as [string, number, string];
        return ((raw as string[]) ?? [])
          .slice(start * 2, (Number(stop) + 1) * 2)
          .map((v) => Buffer.from(v));
      }
      case 'xrangeBuffer': {
        const [, start, , , count] = args as [string, string, string, string, number];
        const entries = (raw as Array<[string, Record<string, string>]>) ?? [];
        const from = start.startsWith('(')
          ? entries.findIndex(([id]) => id === start.slice(1)) + 1
          : 0;
        return entries
          .slice(from, from + Number(count))
          .map(([id, fields]) => [
            Buffer.from(id),
            Object.entries(fields).flatMap(([f, v]) => [Buffer.from(f), Buffer.from(v)]),
          ]);
      }
      case 'call':
      case 'callBuffer': {
        const command = String(args[0]).toUpperCase();
        if (WRITE_CALLS.includes(command)) throw new Error(`write command ${command} issued`);
        if (command === 'CLIENT' && args[1] === 'NO-TOUCH') {
          if (this.noTouchError) throw this.noTouchError;
          return 'OK';
        }
        if (command === 'JSON.GET') return e ? Buffer.from(raw as string) : null;
        if (command === 'JSON.DEBUG' && args[1] === 'MEMORY') {
          if (!e || e.jsonMemory === null || e.jsonMemory === undefined) {
            throw new Error('ERR unknown command');
          }
          return e.jsonMemory;
        }
        throw new Error(`unexpected call ${command}`);
      }
      default:
        throw new Error(`unexpected command ${name}`);
    }
  }

  pipeline() {
    const ops: Array<{ name: string; args: unknown[] }> = [];
    const chain: Record<string, unknown> = {};
    for (const name of READ_COMMANDS) {
      chain[name] = (...args: unknown[]) => {
        this.record(`pipeline.${name}`, args);
        ops.push({ name, args });
        return chain;
      };
    }
    for (const name of WRITE_COMMANDS) {
      chain[name] = () => {
        throw new Error(`write command ${name} issued in pipeline`);
      };
    }
    chain.exec = async () => {
      this.pipelineExecs++;
      return ops.map(({ name, args }) => {
        try {
          return [null, this.run(name, args)];
        } catch (err) {
          return [err, null];
        }
      });
    };
    return chain;
  }
}

export function masterNode(
  id: string,
  address: string,
  extraFlags: string[] = [],
  slots: number[][] = [[0, 16383]],
): ClusterNode {
  return {
    id,
    address: `${address}@17000`,
    flags: ['master', ...extraFlags],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 0,
    linkState: 'connected',
    slots,
  };
}

export function fakeDb(parent: FakeValkey, cluster?: { nodes: ClusterNode[] }): DatabasePort {
  return {
    getClient: () => parent as unknown as Valkey,
    getCapabilities: () => ({ clusterEnabled: cluster !== undefined }),
    getClusterNodes: async () => cluster?.nodes ?? [],
  } as unknown as DatabasePort;
}
