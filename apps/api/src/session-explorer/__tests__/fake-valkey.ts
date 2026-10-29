import type Valkey from 'iovalkey';
import type { DatabasePort } from '../../common/interfaces/database-port.interface';
import type { ClusterNode } from '../../common/types/metrics.types';

export interface FakeEntry {
  type: string;
  pttl?: number;
  memory?: number | null;
  sampledMemory?: number;
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
  'exists',
  'hstrlen',
  'hmgetBuffer',
  'memory',
  'object',
  'strlen',
  'llen',
  'zcard',
  'xlen',
  'hlen',
  'scard',
  'getBuffer',
  'getrangeBuffer',
  'lrangeBuffer',
  'hgetallBuffer',
  'hscanBuffer',
  'smembersBuffer',
  'sscanBuffer',
  'zrangeBuffer',
  'xrangeBuffer',
  'callBuffer',
  'call',
];

const KEY_INDEPENDENT = new Set(['memory', 'object']);

const sizeOf = (v: unknown): number => {
  if (Buffer.isBuffer(v)) return v.length;
  if (Array.isArray(v)) return v.reduce((sum: number, x) => sum + sizeOf(x), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((sum: number, x) => sum + sizeOf(x), 0);
  return 0;
};

export class FakeValkey {
  calls: Array<{ name: string; args: unknown[] }> = [];
  fetchedBytes = 0;
  pipelineExecs = 0;
  scanPages?: string[][];
  connectError?: Error;
  noTouchError?: Error;
  duplicateWith?: FakeValkey;
  disconnected = false;
  options: Record<string, unknown>;
  failKeys = new Map<string, string>();
  movedKeys = new Set<string>();
  failTypeKeys = new Set<string>();
  failHstrlen = false;
  lfu = false;
  noValues = true;

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
    const result = this.answer(name, args);
    this.fetchedBytes += sizeOf(result);
    return result;
  }

  private answer(name: string, args: unknown[]): unknown {
    const key = this.keyOf(name, args);
    if (this.movedKeys.has(key)) throw new Error('MOVED 1 10.0.0.9:7000');
    if (name === 'type' && this.failTypeKeys.has(key)) throw new Error('ERR type failed');
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
      case 'exists':
        return e ? 1 : 0;
      case 'hstrlen': {
        if (this.failHstrlen) throw new Error('ERR hstrlen failed');
        const v = (raw as Record<string, string | Buffer> | undefined)?.[args[1] as string];
        return v === undefined ? 0 : Buffer.from(v).length;
      }
      case 'hmgetBuffer':
        return (args.slice(1) as string[]).map((f) => {
          const v = (raw as Record<string, string | Buffer> | undefined)?.[f];
          return v === undefined ? null : Buffer.from(v);
        });
      case 'memory':
        if (e && e.memory === null) throw new Error('NOPERM memory');
        if (e && e.sampledMemory !== undefined && !args.includes('SAMPLES')) return e.sampledMemory;
        return e ? (e.memory ?? 100) : null;
      case 'object':
        if (this.lfu) {
          throw new Error('ERR An LFU maxmemory policy is selected, idle time not tracked.');
        }
        if (!e) throw new Error('ERR no such key');
        return e.idle ?? 0;
      case 'strlen':
        return e ? Buffer.from(raw as string | Buffer).length : 0;
      case 'llen':
        return e ? (raw as unknown[]).length : 0;
      case 'zcard':
        return e ? (raw as unknown[]).length / 2 : 0;
      case 'xlen':
        return e ? (raw as unknown[]).length : 0;
      case 'scard':
        return e ? (raw as unknown[]).length : 0;
      case 'smembersBuffer':
        return ((raw as string[]) ?? []).map((v) => Buffer.from(v));
      case 'sscanBuffer': {
        const [, cursor, , count] = args as [string, string, string, number];
        const members = (raw as string[]) ?? [];
        const from = Number(cursor);
        const to = from + Number(count);
        return [
          Buffer.from(to >= members.length ? '0' : String(to)),
          members.slice(from, to).map((v) => Buffer.from(v)),
        ];
      }
      case 'hlen':
        return e ? Object.keys(raw as object).length : 0;
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
      case 'hscanBuffer': {
        const [, cursor, , count, flag] = args as [string, string, string, number, string?];
        if (flag === 'NOVALUES' && !this.noValues) throw new Error('ERR syntax error');
        const fields = Object.entries((raw as Record<string, string>) ?? {});
        const from = Number(cursor);
        const to = from + Number(count);
        const page = fields.slice(from, to);
        return [
          Buffer.from(to >= fields.length ? '0' : String(to)),
          flag === 'NOVALUES'
            ? page.map(([k]) => Buffer.from(k))
            : page.flatMap(([k, v]) => [Buffer.from(k), Buffer.from(v)]),
        ];
      }
      case 'zrangeBuffer': {
        const [, start, stop] = args as [string, number, string];
        return ((raw as string[]) ?? [])
          .slice(start * 2, (Number(stop) + 1) * 2)
          .map((v) => Buffer.from(v));
      }
      case 'xrangeBuffer': {
        const [, start, , , count] = args as [string, string, string, string, number];
        const entries = (raw as Array<[string, Record<string, string>]>) ?? [];
        if (start.startsWith('(')) throw new Error('ERR Invalid stream ID specified as stream command argument');
        const idOf = (id: string) => id.split('-').map(BigInt) as [bigint, bigint];
        const [startMs, startSeq] = start === '-' ? [0n, 0n] : idOf(start);
        const index = entries.findIndex(([id]) => {
          const [ms, seq] = idOf(id);
          return ms > startMs || (ms === startMs && seq >= startSeq);
        });
        const from = index === -1 ? entries.length : index;
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
