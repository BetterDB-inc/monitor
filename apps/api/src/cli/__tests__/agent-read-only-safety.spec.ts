import { checkAgentReadOnly, AGENT_READ_ONLY_MESSAGE } from '@betterdb/shared';

describe('checkAgentReadOnly', () => {
  it.each([
    ['SLOWLOG', ['RESET']],
    ['COMMANDLOG', ['RESET', 'slow']],
    ['LATENCY', ['RESET']],
    ['LATENCY', ['reset', 'command']],
    ['ACL', ['LOG', 'RESET']],
  ])('denies %s %j because it clears diagnostic state', (command, args) => {
    expect(checkAgentReadOnly(command, args)).toBe(AGENT_READ_ONLY_MESSAGE);
  });

  it.each([
    ['CLIENT', ['KILL', 'ID', '42']],
    ['CONFIG', ['SET', 'maxmemory', '1gb']],
    ['CONFIG', ['REWRITE']],
    ['ACL', ['SETUSER', 'x', 'on']],
    ['CLUSTER', ['FAILOVER']],
    ['FLUSHALL', []],
    ['SET', ['k', 'v']],
    ['DEL', ['k']],
  ])('denies %s %j because it changes server state', (command, args) => {
    expect(checkAgentReadOnly(command, args)).toBe(AGENT_READ_ONLY_MESSAGE);
  });

  it('allows the read path the monitor polls', () => {
    expect(checkAgentReadOnly('INFO')).toBeNull();
    expect(checkAgentReadOnly('PING', [])).toBeNull();
    expect(checkAgentReadOnly('SLOWLOG', ['GET', '128'])).toBeNull();
    expect(checkAgentReadOnly('COMMANDLOG', ['LEN', 'slow'])).toBeNull();
    expect(checkAgentReadOnly('LATENCY', ['LATEST'])).toBeNull();
    expect(checkAgentReadOnly('ACL', ['LOG', '10'])).toBeNull();
    expect(checkAgentReadOnly('CLIENT', ['LIST'])).toBeNull();
    expect(checkAgentReadOnly('CONFIG', ['GET', 'maxmemory'])).toBeNull();
    expect(checkAgentReadOnly('CLUSTER', ['NODES'])).toBeNull();
    expect(checkAgentReadOnly('COLLECT_KEY_ANALYTICS', ['{}'])).toBeNull();
  });
});
