import type Valkey from 'iovalkey';
import { estimate } from '../../../../proprietary/cache-simulator/size-estimator';
import { sampleNodes, SAMPLE_BUDGET, SAMPLE_DEADLINE_MS } from '../../../../proprietary/cache-simulator/stratified-sampler';
import type { SamplerClient } from '../../../../proprietary/cache-simulator/sample-types';
import { SCENARIOS } from './scenarios';
import { connect, parseTarget, seed } from './seed';

async function groundTruth(client: Valkey): Promise<number> {
  let cursor = '0';
  let total = 0;
  do {
    const [next, keys] = await client.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const pipeline = client.pipeline();
    keys.forEach((key) => pipeline.call('MEMORY', 'USAGE', key, 'SAMPLES', '0'));
    for (const [error, size] of (await pipeline.exec()) ?? []) if (!error && typeof size === 'number') total += size;
  } while (cursor !== '0');
  return total;
}

function adapter(client: Valkey): SamplerClient {
  return {
    call: (command: string, args: string[]) => client.call(command, ...args),
    getClient: () => client,
    getDbSize: () => client.dbsize(),
  } as unknown as SamplerClient;
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const client = await connect(target);
  let failed = false;
  try {
    for (const scenario of SCENARIOS.filter((candidate) => !target.scenario || candidate.name === target.scenario)) {
      let covered = 0;
      let worst = 0;
      for (let run = 1; run <= scenario.runs; run++) {
        await seed(client, scenario.generate(run));
        const truth = await groundTruth(client);
        const result = estimate(await sampleNodes([{ name: 'validate', client: adapter(client) }], { budget: SAMPLE_BUDGET, deadlineMs: SAMPLE_DEADLINE_MS }), Date.now());
        const error = Math.abs(result.totalBytes - truth) / truth;
        worst = Math.max(worst, error);
        if (Math.abs(result.totalBytes - truth) <= result.ci95Bytes + 0.001 * truth) covered += 1;
        await client.flushdb();
      }
      const required = scenario.runs - Math.floor(scenario.runs / 10);
      const pass = worst <= scenario.tolerance && covered >= required;
      failed ||= !pass;
      console.log(`${pass ? 'PASS' : 'FAIL'} ${scenario.name}: worst error ${(worst * 100).toFixed(2)}% (limit ${scenario.tolerance * 100}%), CI coverage ${covered}/${scenario.runs} (need ${required})`);
    }
  } finally {
    client.disconnect();
  }
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
