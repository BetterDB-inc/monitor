// Entry point inside the harness image (Jobs/Deployments). Host-side orchestration is src/cli.ts.
import { loadConfig, type SimConfig } from './config.js';
import { appGen } from './load/app-gen.js';
import { inject } from './load/inject.js';
import { warm } from './load/warm.js';
import { truthCollector } from './truth/collector.js';
import { clusterClient, keyPerSlot } from './valkey.js';

const commands: Record<string, (cfg: SimConfig) => Promise<void>> = {
  warm,
  'app-gen': appGen,
  truth: truthCollector,
  inject,
  // SET then GET one key in every slot through the cluster client.
  async smoke(cfg) {
    const client = await clusterClient(cfg);
    const keys = keyPerSlot('smoke');
    const batch = cfg.clients.smokeConcurrency;
    let bad = 0;
    for (let i = 0; i < keys.length; i += batch) {
      const chunk = keys.slice(i, i + batch);
      await Promise.all(chunk.map((k) => client.set(k, k)));
      const got = await Promise.all(chunk.map((k) => client.get(k)));
      bad += got.filter((v, j) => String(v) !== chunk[j]).length;
    }
    await Promise.all(Array.from({ length: Math.ceil(keys.length / batch) }, (_, i) => client.del(keys.slice(i * batch, (i + 1) * batch))));
    client.close();
    console.log(JSON.stringify({ smoke: { slots: keys.length, mismatches: bad } }));
    if (bad) process.exit(1);
  },
};

const [cmd] = process.argv.slice(2);
const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
  console.error(`usage: incluster <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
await fn(loadConfig());
