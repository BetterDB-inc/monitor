import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Valkey from 'iovalkey';
import { HERE, PASSWORD, assertPort } from './common.mjs';

const OUT_DIR = resolve(HERE, '../../apps/api/test/fixtures/session-explorer');
const decoder = new TextDecoder('utf-8', { fatal: true });

function decodeString(buf) {
  try {
    return decoder.decode(buf);
  } catch {
    return { base64: buf.toString('base64') };
  }
}

async function readValue(client, key, type) {
  switch (type) {
    case 'string':
      return decodeString(await client.getBuffer(key));
    case 'list':
      return client.lrange(key, 0, -1);
    case 'hash':
      return client.hgetall(key);
    case 'zset': {
      const flat = await client.zrange(key, 0, -1, 'WITHSCORES');
      const out = [];
      for (let i = 0; i < flat.length; i += 2) out.push({ member: flat[i], score: Number(flat[i + 1]) });
      return out;
    }
    case 'ReJSON-RL':
      return JSON.parse(await client.call('JSON.GET', key, '.'));
    case 'stream':
      return client.xrange(key, '-', '+');
    default:
      return null;
  }
}

async function scanKeys(client, pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return [...new Set(keys)].sort();
}

async function valkeyVersion(client) {
  const info = await client.info('server');
  const match = info.match(/valkey_version:(\S+)/) ?? info.match(/redis_version:(\S+)/);
  return match ? match[1] : 'unknown';
}

const seed = JSON.parse(readFileSync(join(HERE, 'seed-expectations.json'), 'utf8'));
mkdirSync(OUT_DIR, { recursive: true });

for (const [library, entry] of Object.entries(seed)) {
  assertPort(entry.port);
  const client = new Valkey({ port: entry.port, password: PASSWORD });
  const keys = [];
  for (const key of await scanKeys(client, entry.namespace)) {
    const type = await client.type(key);
    const pttl = await client.pttl(key);
    const value = await readValue(client, key, type);
    keys.push({ key, type, pttl, value });
  }
  if (keys.length === 0) throw new Error(`${library}: no keys captured for ${entry.namespace}`);
  const fixture = {
    library,
    version: entry.version,
    preset: entry.preset,
    namespace: entry.namespace,
    capturedAt: new Date().toISOString(),
    valkey: { port: entry.port, version: await valkeyVersion(client) },
    keys,
    expectations: entry.expectations,
  };
  await client.quit();
  const file = join(OUT_DIR, `${entry.preset}@${entry.version}.json`);
  writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`${library}: ${keys.length} keys -> ${file}`);
}
