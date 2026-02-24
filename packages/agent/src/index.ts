#!/usr/bin/env node

import { Agent, AgentConfig } from './agent';

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && i + 1 < args.length) {
      const key = arg.slice(2);
      parsed[key] = args[++i];
    }
  }

  const token = parsed['token'] || process.env.BETTERDB_TOKEN || '';
  const cloudUrl = parsed['cloud-url'] || process.env.BETTERDB_CLOUD_URL || '';

  if (!token) {
    console.error('Error: BETTERDB_TOKEN or --token is required');
    process.exit(1);
  }
  if (!cloudUrl) {
    console.error('Error: BETTERDB_CLOUD_URL or --cloud-url is required');
    process.exit(1);
  }

  return {
    token,
    cloudUrl,
    valkeyHost: parsed['valkey-host'] || process.env.VALKEY_HOST || 'localhost',
    valkeyPort: parseInt(parsed['valkey-port'] || process.env.VALKEY_PORT || '6379', 10),
    valkeyUsername: parsed['valkey-username'] || process.env.VALKEY_USERNAME || 'default',
    valkeyPassword: parsed['valkey-password'] || process.env.VALKEY_PASSWORD || '',
    valkeyTls: (parsed['valkey-tls'] || process.env.VALKEY_TLS || 'false') === 'true',
    valkeyDb: parseInt(parsed['valkey-db'] || process.env.VALKEY_DB || '0', 10),
  };
}

async function main(): Promise<void> {
  const config = parseArgs();
  const agent = new Agent(config);

  console.log(`BetterDB Agent v0.1.0`);
  console.log(`Connecting to valkey://${config.valkeyHost}:${config.valkeyPort}`);

  const shutdown = async () => {
    await agent.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await agent.start();
  } catch (err: any) {
    console.error(`Failed to start agent: ${err.message}`);
    process.exit(1);
  }
}

main();
