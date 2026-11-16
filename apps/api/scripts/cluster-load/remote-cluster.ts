import { fork, type ChildProcess } from 'child_process';
import { join } from 'path';
import type { FakeClusterOptions, FakeClusterStats, FakeNode } from '../../test/load/fake-cluster';
import type { ProcessLoad } from './process-load';

const CALL_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 120_000;
const PROCESS_EXITED = 'Fake cluster process exited';

export type RemoteClusterStats = FakeClusterStats & { load: ProcessLoad };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class RemoteCluster {
  nodes: FakeNode[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  private constructor(private readonly child: ChildProcess) {
    child.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.result);
    });
    child.on('exit', () => this.rejectPending(new Error(PROCESS_EXITED)));
    child.on('error', (failure) => this.rejectPending(failure));
  }

  static async start(options: FakeClusterOptions): Promise<RemoteCluster> {
    const child = fork(join(__dirname, 'cluster-process.ts'), [], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const remote = new RemoteCluster(child);
    try {
      remote.nodes = (await remote.request('start', START_TIMEOUT_MS, options)) as FakeNode[];
    } catch (failure) {
      child.kill();
      throw failure;
    }
    return remote;
  }

  stats(): Promise<RemoteClusterStats> {
    return this.call('stats') as Promise<RemoteClusterStats>;
  }

  async resetStats(): Promise<void> {
    await this.call('resetStats');
  }

  async hang(index: number): Promise<void> {
    await this.call('hang', index);
  }

  async resume(index: number): Promise<void> {
    await this.call('resume', index);
  }

  failover(shard: number): Promise<FakeNode> {
    return this.call('failover', shard) as Promise<FakeNode>;
  }

  async stop(): Promise<void> {
    await this.call('stop').catch(() => undefined);
    this.child.kill();
  }

  private call(method: string, ...args: unknown[]): Promise<unknown> {
    return this.request(method, CALL_TIMEOUT_MS, ...args);
  }

  private request(method: string, timeoutMs: number, ...args: unknown[]): Promise<unknown> {
    if (!this.child.connected) return Promise.reject(new Error(PROCESS_EXITED));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Fake cluster did not answer "${method}" within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, method, args }, (failure) => {
        if (!failure || !this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(failure);
      });
    });
  }

  private rejectPending(reason: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.pending.clear();
  }
}
