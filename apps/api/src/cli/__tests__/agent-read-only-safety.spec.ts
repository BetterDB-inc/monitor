import { checkAgentReadOnly, checkBlocked, checkSafeMode, redactConfigGetReply, redactSensitiveReply, AGENT_READ_ONLY_MESSAGE } from '@betterdb/shared';

describe('redactSensitiveReply', () => {
  const hash = 'a'.repeat(64);

  it('redacts password hashes and plaintext passwords in ACL LIST rules, keeping the rest', () => {
    expect(redactSensitiveReply('ACL', ['LIST'], [
      `user default on #${hash} ~* &* +@all`,
      'user monitor on nopass ~* resetchannels -@all +@read',
      `user app on #${hash} #${'b'.repeat(64)} >plain ~app:* +get`,
    ])).toEqual([
      'user default on #<redacted> ~* &* +@all',
      'user monitor on nopass ~* resetchannels -@all +@read',
      'user app on #<redacted> #<redacted> ><redacted> ~app:* +get',
    ]);
  });

  it('redacts the passwords of ACL GETUSER in both reply shapes', () => {
    expect(redactSensitiveReply('acl', ['getuser', 'default'], ['flags', ['on'], 'passwords', [hash], 'commands', '+@all', 'keys', '~*']))
      .toEqual(['flags', ['on'], 'passwords', ['<redacted>'], 'commands', '+@all', 'keys', '~*']);
    expect(redactSensitiveReply('ACL', ['GETUSER', 'default'], { flags: ['on'], passwords: [hash], keys: '~*' }))
      .toEqual({ flags: ['on'], passwords: ['<redacted>'], keys: '~*' });
  });

  it('routes CONFIG GET to the config redaction and leaves other replies alone', () => {
    expect(redactSensitiveReply('config', ['get', '*'], ['requirepass', 'p'])).toEqual(['requirepass', '<redacted>']);
    expect(redactSensitiveReply('ACL', ['USERS'], ['default', 'app'])).toEqual(['default', 'app']);
    expect(redactSensitiveReply('ACL', ['LOG', '10'], [['count', 1]])).toEqual([['count', 1]]);
    expect(redactSensitiveReply('INFO', ['server'], 'redis_version:7')).toBe('redis_version:7');
  });
});

describe('redactSensitiveReply with a fingerprint', () => {
  const hash = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  // Stands in for the agent's keyed HMAC.
  const fingerprint = (secret: string) => secret.slice(0, 4) + String(secret.length);

  it('tags each secret so a changed hash or password still shows', () => {
    const before = redactSensitiveReply('ACL', ['LIST'], [`user app on #${hash} ~* +@all`], fingerprint) as string[];
    const after = redactSensitiveReply('ACL', ['LIST'], [`user app on #${other} ~* +@all`], fingerprint) as string[];

    expect(before).toEqual(['user app on #<redacted:aaaa64> ~* +@all']);
    expect(after).not.toEqual(before);
    expect(before.join()).not.toContain(hash);
    expect(redactSensitiveReply('CONFIG', ['GET', 'masterauth'], ['masterauth', 'secret'], fingerprint))
      .toEqual(['masterauth', '<redacted:secr6>']);
    expect(redactSensitiveReply('ACL', ['GETUSER', 'app'], { passwords: [hash] }, fingerprint))
      .toEqual({ passwords: ['<redacted:aaaa64>'] });
  });

  it('keeps what the agent already redacted when the Monitor redacts again without a key', () => {
    const fromAgent = redactSensitiveReply('ACL', ['LIST'], [`user app on #${hash} >pw ~*`], fingerprint);
    expect(redactSensitiveReply('ACL', ['LIST'], fromAgent)).toEqual(fromAgent);
    const config = redactSensitiveReply('CONFIG', ['GET', '*'], ['requirepass', 'pw', 'maxmemory', '0'], fingerprint);
    expect(redactSensitiveReply('CONFIG', ['GET', '*'], config)).toEqual(config);
  });
});

describe('NUL bytes in command names', () => {
  it.each([
    ['CONFIG', 'GET\0'],
    ['CONFIG\0', 'GET'],
    ['FLUSHALL\0', undefined],
  ])('refuses %j %j in every check, as Valkey would read it differently', (command, sub) => {
    expect(checkBlocked(command, sub)).toMatch(/NUL/);
    expect(checkSafeMode(command, sub)).toMatch(/NUL/);
    expect(checkAgentReadOnly(command, sub === undefined ? [] : [sub])).toBe(AGENT_READ_ONLY_MESSAGE);
  });
});

describe('redactConfigGetReply', () => {
  it('redacts every credential parameter in a flat reply and keeps the rest', () => {
    expect(redactConfigGetReply(['requirepass', 'p', 'maxmemory', '1gb', 'masterauth', 'p', 'MasterUser', 'u', 'tls-key-file-pass', 'k']))
      .toEqual(['requirepass', '<redacted>', 'maxmemory', '1gb', 'masterauth', '<redacted>', 'MasterUser', '<redacted>', 'tls-key-file-pass', '<redacted>']);
  });

  it('leaves an unset credential empty, so "no password" still reads as such', () => {
    expect(redactConfigGetReply(['requirepass', ''])).toEqual(['requirepass', '']);
  });

  it('handles RESP3 maps and passes anything else through', () => {
    expect(redactConfigGetReply({ requirepass: 'p', maxmemory: '0' })).toEqual({ requirepass: '<redacted>', maxmemory: '0' });
    expect(redactConfigGetReply('OK')).toBe('OK');
    expect(redactConfigGetReply(['odd'])).toEqual(['odd']);
  });

});

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

  it.each([
    ['ACL', ['LOG', 'RESET\0']],
    ['ACL', ['LOG', 'reset\0anything']],
    ['SLOWLOG', ['RESET\0']],
  ])('denies %s %j: Valkey compares keywords up to the first NUL', (command, args) => {
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
    expect(checkAgentReadOnly('CLUSTER', ['SHARDS'])).toBeNull();
    expect(checkAgentReadOnly('COLLECT_KEY_ANALYTICS', ['{}'])).toBeNull();
  });
});
