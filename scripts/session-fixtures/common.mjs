import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ALLOWED_PORTS = [6380];
export const PASSWORD = process.env.VALKEY_PASSWORD ?? 'devpassword';
const FILLER = 'The quick brown fox jumps over the lazy dog. ';

export function assertPort(port) {
  if (!ALLOWED_PORTS.includes(port)) {
    console.error(`refusing port ${port}: only 6380 is allowed`);
    process.exit(1);
  }
}

export function url(port) {
  assertPort(port);
  return `redis://:${PASSWORD}@localhost:${port}/0`;
}

function filler(chars, tag) {
  return (`[${tag}] ` + FILLER.repeat(Math.floor(chars / FILLER.length) + 1)).slice(0, chars);
}

export function loadSessions(oversizePairs) {
  const spec = JSON.parse(readFileSync(join(HERE, 'session-spec.json'), 'utf8'));
  const sessions = {};
  for (const [sid, entry] of Object.entries(spec)) {
    const messages = entry.messages.map(({ generate, ...m }) =>
      generate ? { ...m, content: filler(generate.chars, generate.tag) } : m,
    );
    if (entry.oversize) {
      const pairs = oversizePairs ?? entry.oversize.pairs;
      for (let i = 0; i < pairs; i++) {
        messages.push({ role: 'human', content: filler(entry.oversize.chars, `q${i}`) });
        messages.push({ role: 'ai', content: filler(entry.oversize.chars, `a${i}`) });
      }
    }
    sessions[sid] = { messages, ttl: entry.ttl ?? null };
  }
  return sessions;
}

export function buildExpectations(sessions) {
  const out = {};
  for (const [sid, s] of Object.entries(sessions)) {
    const e = {
      messages: s.messages.length,
      toolCalls: s.messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0),
      roles: s.messages.map((m) => m.role),
      hasTtl: s.ttl !== null,
    };
    if (sid !== 'oversize') e.contents = s.messages.map((m) => m.content);
    out[sid] = e;
  }
  return out;
}

export function writeSeed(library, meta, expectations) {
  const path = join(HERE, 'seed-expectations.json');
  const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  data[library] = { ...meta, expectations };
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export async function purge(client, pattern) {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = next;
    if (keys.length > 0) await client.unlink(...keys);
  } while (cursor !== '0');
}

export function packageVersion(name) {
  return JSON.parse(readFileSync(join(HERE, 'node_modules', name, 'package.json'), 'utf8')).version;
}

export async function lcMessage(m) {
  const { AIMessage, HumanMessage, SystemMessage, ToolMessage } = await import('@langchain/core/messages');
  if (m.role === 'system') return new SystemMessage({ content: m.content });
  if (m.role === 'human') return new HumanMessage({ content: m.content });
  if (m.role === 'ai') {
    const tool_calls = (m.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args, type: 'tool_call' }));
    return new AIMessage({ content: m.content, tool_calls });
  }
  return new ToolMessage({ content: m.content, tool_call_id: m.toolCallId, name: m.name });
}
