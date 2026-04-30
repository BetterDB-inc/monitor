import { createEmbedder } from './embedder.js';
import { SCENARIOS, findScenario } from './scenarios/index.js';

interface ParsedArgs {
  scenario?: string;
  host: string;
  port: number;
  password: string | undefined;
  cacheName: string | undefined;
  list: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    host: process.env.SEED_VALKEY_HOST ?? 'localhost',
    port: Number(process.env.SEED_VALKEY_PORT ?? '6391'),
    password: process.env.SEED_VALKEY_PASSWORD,
    cacheName: undefined,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario') {
      out.scenario = argv[++i];
    } else if (arg === '--host') {
      out.host = argv[++i] ?? out.host;
    } else if (arg === '--port') {
      out.port = Number(argv[++i] ?? out.port);
    } else if (arg === '--password') {
      out.password = argv[++i];
    } else if (arg === '--cache-name') {
      out.cacheName = argv[++i];
    } else if (arg === '--list') {
      out.list = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`@betterdb/cache-fixtures — seed Valkey with realistic cache state.

Usage:
  pnpm --filter @betterdb/cache-fixtures seed -- --scenario <id> [options]

Options:
  --scenario <id>      Scenario to run (required unless --list)
  --host <host>        Valkey host (default: localhost, env SEED_VALKEY_HOST)
  --port <port>        Valkey port (default: 6391, env SEED_VALKEY_PORT)
  --password <pw>      Valkey password (env SEED_VALKEY_PASSWORD)
  --cache-name <name>  Override cache namespace (default: scenario default)
  --list               List available scenarios
  --help, -h           Show this help

Embedding model is configured via OLLAMA_HOST and EMBED_MODEL env vars.
Embeddings are cached to scripts/cache-fixtures/.embeddings/ between runs.`);
}

function printList(): void {
  console.log('Available scenarios:\n');
  for (const s of SCENARIOS) {
    console.log(`  ${s.id} (${s.cacheKind})`);
    console.log(`    default cache name: ${s.defaultCacheName}`);
    console.log(`    ${s.description}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }
  if (args.list) {
    printList();
    return;
  }
  if (!args.scenario) {
    console.error('Error: --scenario is required. Run with --list to see options.');
    process.exit(2);
  }

  const scenario = findScenario(args.scenario);
  if (!scenario) {
    console.error(`Unknown scenario "${args.scenario}". Run with --list to see options.`);
    process.exit(2);
  }

  const cacheName = args.cacheName ?? scenario.defaultCacheName;
  const embedFn = await createEmbedder();

  console.log(`Running scenario: ${scenario.id}`);
  console.log(`  cacheKind: ${scenario.cacheKind}`);
  console.log(`  cacheName: ${cacheName}`);
  console.log(`  valkey:    ${args.host}:${args.port}\n`);

  const start = Date.now();
  const result = await scenario.run({
    valkeyHost: args.host,
    valkeyPort: args.port,
    valkeyPassword: args.password,
    cacheName,
    embedFn,
  });
  const elapsedMs = Date.now() - start;

  const stats = (embedFn as unknown as { stats?: () => { hits: number; misses: number } }).stats?.();
  console.log(`Done in ${elapsedMs}ms`);
  console.log(`  entries: ${result.entries}`);
  if (result.details) {
    console.log(`  details: ${JSON.stringify(result.details)}`);
  }
  if (stats) {
    console.log(`  embed cache: ${stats.hits} hits, ${stats.misses} misses`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
