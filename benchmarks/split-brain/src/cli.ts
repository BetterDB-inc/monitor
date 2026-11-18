import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { collectAll, collectChunk } from './collect-run';
import { HostWatch } from './host';
import { inspect } from './inspect';
import { assertPinned, writePin } from './product';
import { buildReport } from './report';
import { buildImage, down, run } from './run';

const root = join(__dirname, '..');

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main(): Promise<void> {
  const [commandName, target] = process.argv.slice(2);
  switch (commandName) {
    case 'build':
      await buildImage(root);
      return;
    case 'down':
      await down();
      return;
    case 'record': {
      const only = flag('scenarios', '');
      const result = await run({
        outDir: join(root, 'runs', flag('out', 'stage1')),
        lanes: flag('lanes', '1').split(',').map(Number),
        trials: Number(flag('trials', '30')),
        only: only ? only.split(',') : null,
        seed: Number(flag('seed', '697')),
        nodeTimeoutMs: Number(flag('node-timeout', '5000')),
        clusterSize: Number(flag('size', '6')),
        maxLoad: Number(flag('max-load', String(Math.round(availableParallelism() * 7.5) / 10))),
        minFreePorts: Number(flag('min-free-ports', '8000')),
        maxWaitMs: Number(flag('max-wait-minutes', '30')) * 60_000,
      });
      if (result.failed.length > 0) process.exitCode = 1;
      return;
    }
    case 'pin':
      console.log(`pinned ${Object.keys(writePin(target).files).length} detector files at ${target}`);
      return;
    case 'replay': {
      const only = flag('scenarios', '');
      const name = flag('runs', 'stage1');
      const outFile = await collectAll(
        join(root, 'runs', name),
        join(root, 'results', flag('out', name)),
        Number(flag('jobs', String(Math.max(1, availableParallelism() - 2)))),
        only ? only.split(',') : null,
      );
      console.log(`wrote ${outFile}`);
      return;
    }
    case 'collect-chunk':
      await collectChunk(target, process.argv.slice(4));
      return;
    case 'report': {
      const name = flag('results', 'stage1');
      const report = buildReport({
        title: flag('title', 'Split-brain detection by node coverage: Stage 1 (6 nodes)'),
        trialsFile: join(root, 'results', name, 'trials.jsonl.gz'),
        pin: assertPinned(),
        findingsFile: join(root, 'results', name, 'findings.md'),
        limitationsFile: join(root, 'results', name, 'limitations.md'),
      });
      const outFile = join(root, flag('to', 'RESULTS.md'));
      writeFileSync(outFile, report);
      console.log(`wrote ${outFile}`);
      return;
    }
    case 'host': {
      const sample = await new HostWatch({ maxLoad: 0, minFreePorts: 0 }).sample();
      console.log(`load ${sample.load.toFixed(1)}, ${sample.freePorts} free local ports`);
      return;
    }
    case 'inspect':
      console.log(inspect(target));
      return;
    default:
      console.error('usage: bench <build|record|replay|report|pin <commit>|inspect <trace>|down|host> [--flags]');
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
