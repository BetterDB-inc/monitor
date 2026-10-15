import Valkey from 'iovalkey';
import { SCENARIOS, type SeedCommand } from './scenarios';

export interface Target {
  url: string;
  db: number;
}

export function parseTarget(argv: string[]): Target & { scenario?: string; seed: number } {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const url = value('--url');
  const db = Number(value('--db'));
  if (!url || !Number.isInteger(db) || db <= 0) {
    throw new Error('Pass --url <redis-url> and --db <index greater than 0>; the target database must be empty');
  }
  return { url, db, scenario: value('--scenario'), seed: Number(value('--seed') ?? 1) };
}

export async function connect(target: Target): Promise<Valkey> {
  const client = new Valkey(target.url, { db: target.db });
  if ((await client.dbsize()) !== 0) {
    client.disconnect();
    throw new Error(`Database ${target.db} is not empty; refusing to seed`);
  }
  return client;
}

async function flush(pipeline: ReturnType<Valkey['pipeline']>): Promise<void> {
  for (const [error] of (await pipeline.exec()) ?? []) if (error) throw error;
}

export async function seed(client: Valkey, commands: Iterable<SeedCommand>): Promise<number> {
  let pipeline = client.pipeline();
  let queued = 0;
  let total = 0;
  for (const command of commands) {
    if (command.type === 'string') pipeline.set(command.key, command.value as string);
    if (command.type === 'hash') pipeline.hset(command.key, Object.fromEntries((command.value as string[]).map((field) => [field, field])));
    if (command.type === 'list') pipeline.rpush(command.key, ...(command.value as string[]));
    if (command.type === 'set') pipeline.sadd(command.key, ...(command.value as string[]));
    if (command.type === 'zset') pipeline.zadd(command.key, ...(command.value as string[]).flatMap((member, index) => [String(index), member]));
    if (command.ttlSeconds !== undefined) pipeline.expire(command.key, command.ttlSeconds);
    queued += 1;
    total += 1;
    if (queued === 1000) {
      await flush(pipeline);
      pipeline = client.pipeline();
      queued = 0;
    }
  }
  if (queued > 0) await flush(pipeline);
  return total;
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const scenario = SCENARIOS.find((candidate) => candidate.name === target.scenario);
  if (!scenario) throw new Error(`Pass --scenario with one of: ${SCENARIOS.map((candidate) => candidate.name).join(', ')}`);
  const client = await connect(target);
  try {
    const count = await seed(client, scenario.generate(target.seed));
    console.log(`Seeded ${count} keys for ${scenario.name} into db ${target.db}`);
  } finally {
    client.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
