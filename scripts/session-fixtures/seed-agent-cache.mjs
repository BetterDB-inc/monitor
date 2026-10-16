import Valkey from 'iovalkey';
import { AgentCache } from '@betterdb/agent-cache';
import { BetterDBSaver } from '@betterdb/agent-cache/langgraph';
import { emptyCheckpoint, uuid6 } from '@langchain/langgraph-checkpoint';
import { assertPort, loadSessions, buildExpectations, writeSeed, purge, packageVersion, lcMessage, PASSWORD } from './common.mjs';

const PORT = 6380;
const NAME = 'sxfix:ac';
const OVERSIZE_PAIRS = 30;
const MAX_PER_TURN_CHECKPOINT_MESSAGES = 12;
assertPort(PORT);

const version = packageVersion('@betterdb/agent-cache');

const client = new Valkey({ port: PORT, password: PASSWORD });
await purge(client, `${NAME}:*`);

function newCache(defaultTtl) {
  return new AgentCache({
    client,
    name: NAME,
    defaultTtl,
    discovery: { enabled: false },
    configRefresh: { enabled: false },
    analytics: { disabled: true },
  });
}

const sessions = loadSessions(OVERSIZE_PAIRS);
const caches = [];
let step = 0;

for (const [sid, s] of Object.entries(sessions)) {
  const cache = newCache(s.ttl ?? undefined);
  caches.push(cache);
  const saver = new BetterDBSaver({ cache });
  const messages = await Promise.all(s.messages.map(lcMessage));
  const boundaries = [];
  messages.forEach((_, i) => {
    const isTurnEnd = s.messages[i].role === 'ai' || i === messages.length - 1;
    if (isTurnEnd) boundaries.push(i + 1);
  });
  const perTurn = messages.length <= MAX_PER_TURN_CHECKPOINT_MESSAGES;
  const cuts = perTurn ? boundaries : [messages.length];

  let config = { configurable: { thread_id: sid, checkpoint_ns: '' } };
  for (const cut of cuts) {
    step += 1;
    const checkpoint = {
      ...emptyCheckpoint(),
      id: uuid6(step),
      channel_values: { messages: messages.slice(0, cut) },
      channel_versions: { messages: step },
    };
    const metadata = { source: 'loop', step, parents: {} };
    config = await saver.put(config, checkpoint, metadata, { messages: step });
    if (perTurn) {
      await saver.putWrites(config, [['messages', [messages[cut - 1]]]], `task-${step}`);
    }
  }
}

for (const cache of caches) await cache.shutdown();
await client.quit();

writeSeed(
  'agent-cache',
  { version, preset: 'agent-cache', namespace: `${NAME}:*`, port: PORT },
  buildExpectations(sessions),
);
