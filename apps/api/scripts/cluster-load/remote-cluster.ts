import { fork, type ChildProcess } from 'child_process';
import { join } from 'path';
import type { FakeClusterOptions, FakeClusterStats, FakeNode } from '../../test/load/fake-cluster';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
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
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.result);
    });
    child.on('exit', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('Fake cluster process exited'));
      this.pending.clear();
    });
  }

  static async start(options: FakeClusterOptions): Promise<RemoteCluster> {
    const child = fork(join(__dirname, 'cluster-process.ts'), [], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const remote = new RemoteCluster(child);
    remote.nodes = (await remote.call('start', options)) as FakeNode[];
    return remote;
  }

  stats(): Promise<FakeClusterStats> {
    return this.call('stats') as Promise<FakeClusterStats>;
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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, method, args });
    });
  }
}
