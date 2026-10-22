import { readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Valkey from 'iovalkey';
import { HERE, PASSWORD, assertPort } from './common.mjs';

const OUT_DIR = resolve(HERE, '../../apps/api/test/fixtures/session-explorer');
const decoder = new TextDecoder('utf-8', { fatal: true });

function decodeString(buf) {
  try {
    return { value: decoder.decode(buf) };
  } catch {
    return { value: buf.toString('base64'), binary: true };
  }
}

async function readValue(client, key, type) {
  switch (type) {
    case 'string':
      return decodeString(await client.getBuffer(key));
    case 'list':
      return { value: await client.lrange(key, 0, -1) };
    case 'hash':
      return { value: await client.hgetall(key) };
    case 'zset': {
      const flat = await client.zrange(key, 0, -1, 'WITHSCORES');
      const out = [];
      for (let i = 0; i < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1])]);
      return { value: out };
    }
    case 'ReJSON-RL':
      return { value: JSON.parse(await client.call('JSON.GET', key, '.')) };
    case 'stream':
      return { value: await client.xrange(key, '-', '+') };
    default:
      return { value: null };
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
    keys.push({ key, type, pttl, ...(await readValue(client, key, type)) });
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
  const name = `${entry.preset}@${entry.version}.json`;
  for (const old of readdirSync(OUT_DIR)) {
    if (old.startsWith(`${entry.preset}@`) && old !== name) rmSync(join(OUT_DIR, old));
  }
  const file = join(OUT_DIR, name);
  writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`${library}: ${keys.length} keys -> ${file}`);
}
