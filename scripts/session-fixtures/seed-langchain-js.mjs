import { createClient } from 'redis';
import Valkey from 'iovalkey';
import { RedisChatMessageHistory } from '@langchain/redis';
import { assertPort, url, loadSessions, buildExpectations, writeSeed, purge, packageVersion, lcMessage, PASSWORD } from './common.mjs';

const PORT = 6380;
const PREFIX = 'sxfix:lcjs:';
assertPort(PORT);

const version = packageVersion('@langchain/redis');

const valkey = new Valkey({ port: PORT, password: PASSWORD });
await purge(valkey, `${PREFIX}*`);
await valkey.quit();

const client = createClient({ url: url(PORT) });
await client.connect();
const sessions = loadSessions();
for (const [sid, s] of Object.entries(sessions)) {
  const history = new RedisChatMessageHistory({
    sessionId: `${PREFIX}${sid}`,
    sessionTTL: s.ttl ?? undefined,
    client,
  });
  for (const m of s.messages) await history.addMessage(await lcMessage(m));
}
await client.quit();

writeSeed(
  'langchain-js',
  { version, preset: 'langchain-js', namespace: `${PREFIX}*`, port: PORT },
  buildExpectations(sessions),
);
