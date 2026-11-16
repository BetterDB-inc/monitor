import { FakeCluster, type FakeClusterOptions } from '../../test/load/fake-cluster';
import { ProcessLoadMeter } from './process-load';

interface Request {
  id: number;
  method: 'start' | 'stats' | 'resetStats' | 'hang' | 'resume' | 'failover' | 'setClusterState' | 'stop';
  args: unknown[];
}

let cluster: FakeCluster | null = null;
const load = new ProcessLoadMeter();

const required = (): FakeCluster => {
  if (!cluster) throw new Error('Cluster not started');
  return cluster;
};

async function handle(request: Request): Promise<unknown> {
  switch (request.method) {
    case 'start':
      cluster = await FakeCluster.start(request.args[0] as FakeClusterOptions);
      load.start();
      return cluster.nodes;
    case 'stats':
      return { ...required().stats(), load: load.read() };
    case 'resetStats':
      load.start();
      return required().resetStats();
    case 'hang':
      return required().hang(request.args[0] as number);
    case 'resume':
      return required().resume(request.args[0] as number);
    case 'failover':
      return required().failover(request.args[0] as number);
    case 'setClusterState':
      return required().setClusterState(request.args[0] as 'ok' | 'fail');
    case 'stop':
      await required().stop();
      setImmediate(() => process.exit(0));
      return null;
  }
}

process.on('message', (request: Request) => {
  handle(request)
    .then((result) => process.send?.({ id: request.id, result }))
    .catch((failure) => process.send?.({ id: request.id, error: failure instanceof Error ? failure.message : String(failure) }));
});

process.on('disconnect', () => process.exit(0));
