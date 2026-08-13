import {
  AppendfsyncHazardInput,
  ConfigHazardInput,
  evaluateAclAofHazard,
  evaluateAppendfsyncHazard,
} from '../config-hazard';

// ACL GETUSER shapes mirror acl-checker.ts: RESP2 flat pair array or RESP3 record.
const resp3User = (flags: string[], commands: string, keys: string, channels: string) => ({
  flags,
  commands,
  keys,
  channels,
});

const resp2User = (flags: string[], commands: string, keys: string, channels: string) => [
  'flags',
  flags,
  'commands',
  commands,
  'keys',
  keys,
  'channels',
  channels,
];

const input = (over: Partial<ConfigHazardInput>): ConfigHazardInput => {
  return {
    appendonly: 'yes',
    version: '8.1.0',
    aclGetUserResult: resp3User(['off'], '-@all', '', ''),
    ...over,
  };
};

describe('evaluateAclAofHazard', () => {
  it('fires the hazard when AOF is on and default is off without the workaround grant', () => {
    const finding = evaluateAclAofHazard(input({}));
    expect(finding).not.toBeNull();
    expect(finding?.status).toBe('hazard');
    expect(finding?.id).toBe('default-user-aof-data-loss');
    expect(finding?.message).toContain('valkey#3983');
    expect(finding?.message).toContain('+@all ~* &*');
  });

  it('parses the RESP2 pair-array shape identically', () => {
    const finding = evaluateAclAofHazard(
      input({ aclGetUserResult: resp2User(['off'], '-@all', '', '') }),
    );
    expect(finding?.status).toBe('hazard');
  });

  it('returns null when AOF is off', () => {
    expect(evaluateAclAofHazard(input({ appendonly: 'no' }))).toBeNull();
  });

  it('returns null when the default user is enabled', () => {
    expect(
      evaluateAclAofHazard(input({ aclGetUserResult: resp3User(['on'], '-@all', '', '') })),
    ).toBeNull();
  });

  it('returns null when default is off but carries the unrestricted workaround grant', () => {
    expect(
      evaluateAclAofHazard(input({ aclGetUserResult: resp3User(['off'], '+@all', '~*', '&*') })),
    ).toBeNull();
  });

  it('treats allkeys/allchannels/allcommands flags as the workaround grant', () => {
    expect(
      evaluateAclAofHazard(
        input({
          aclGetUserResult: resp3User(['off', 'allkeys', 'allchannels'], 'allcommands', '', ''),
        }),
      ),
    ).toBeNull();
  });

  it('does not accept a partial workaround (commands granted but keys restricted)', () => {
    const finding = evaluateAclAofHazard(
      input({ aclGetUserResult: resp3User(['off'], '+@all', '~app:*', '&*') }),
    );
    expect(finding?.status).toBe('hazard');
  });

  it('does not accept +@all when a later rule denies a command category', () => {
    const finding = evaluateAclAofHazard(
      input({ aclGetUserResult: resp3User(['off'], '+@all -@transaction', '~*', '&*') }),
    );
    expect(finding?.status).toBe('hazard');
  });

  it('does not accept +@all when a later rule denies individual commands', () => {
    const finding = evaluateAclAofHazard(
      input({ aclGetUserResult: resp3User(['off'], '+@all -exec -multi', '~*', '&*') }),
    );
    expect(finding?.status).toBe('hazard');
  });

  it('does not accept the allcommands flag when the rules carry an explicit denial', () => {
    const finding = evaluateAclAofHazard(
      input({
        aclGetUserResult: resp3User(['off', 'allkeys', 'allchannels'], 'allcommands -exec', '', ''),
      }),
    );
    expect(finding?.status).toBe('hazard');
  });

  it('returns an unverified finding when ACL GETUSER was denied', () => {
    const finding = evaluateAclAofHazard(input({ aclGetUserResult: 'denied' }));
    expect(finding?.status).toBe('unverified');
    expect(finding?.message).toContain('could not verify');
  });

  it('returns an unverified finding when ACL GETUSER returns nil', () => {
    // Bugbot (#337): a nil reply must not read as "clean" — only a positively
    // verified safe config may return null. Same contract as the denied path.
    const finding = evaluateAclAofHazard(input({ aclGetUserResult: null }));
    expect(finding?.status).toBe('unverified');
    expect(finding?.message).toContain('could not verify');
  });

  it('returns an unverified finding when the ACL GETUSER reply is unparseable', () => {
    const finding = evaluateAclAofHazard(input({ aclGetUserResult: 42 }));
    expect(finding?.status).toBe('unverified');
  });

  it('returns null below version 6.0 (pre-ACL servers)', () => {
    expect(evaluateAclAofHazard(input({ version: '5.0.7' }))).toBeNull();
  });

  it('still evaluates when the version is unknown', () => {
    const finding = evaluateAclAofHazard(input({ version: null }));
    expect(finding?.status).toBe('hazard');
  });
});

describe('evaluateAppendfsyncHazard', () => {
  const fsyncInput = (over: Partial<AppendfsyncHazardInput>): AppendfsyncHazardInput => {
    return {
      appendonly: 'yes',
      appendfsync: 'always',
      aofDelayedFsync: 0,
      delayedFsyncRisingStreak: 0,
      aofLastWriteStatus: 'ok',
      latencyEvents: [],
      ...over,
    };
  };

  it('returns null when AOF is off, even with appendfsync=always', () => {
    expect(evaluateAppendfsyncHazard(fsyncInput({ appendonly: 'no' }))).toBeNull();
    expect(evaluateAppendfsyncHazard(fsyncInput({ appendonly: null }))).toBeNull();
  });

  it('raises a low-severity advisory for always with no symptoms', () => {
    const finding = evaluateAppendfsyncHazard(fsyncInput({}));
    expect(finding).not.toBeNull();
    expect(finding?.id).toBe('appendfsync-always-blocking');
    expect(finding?.severity).toBe('info');
    expect(finding?.status).toBe('advisory');
    expect(finding?.message).toContain('appendfsync=always');
    expect(finding?.message).toContain('everysec');
    expect(finding?.message).toContain('valkey#3515');
  });

  it('does not escalate always on a rising aof_delayed_fsync', () => {
    // The engine only increments aof_delayed_fsync in the everysec branch of
    // flushAppendOnlyFile(); under always the fsync is inline, so the counter
    // cannot move. Escalating on it here would be an unreachable path.
    const finding = evaluateAppendfsyncHazard(
      fsyncInput({ aofDelayedFsync: 42, delayedFsyncRisingStreak: 3 }),
    );
    expect(finding?.severity).toBe('info');
    expect(finding?.status).toBe('advisory');
    expect(finding?.message).not.toContain('aof_delayed_fsync');
  });

  it('escalates when the aof-fsync-always LATENCY event is present', () => {
    const finding = evaluateAppendfsyncHazard(
      fsyncInput({ latencyEvents: ['aof-fsync-always', 'command'] }),
    );
    expect(finding?.severity).toBe('warning');
    expect(finding?.status).toBe('hazard');
    expect(finding?.message).toContain('aof-fsync-always');
  });

  it('escalates when aof_last_write_status is not ok', () => {
    const finding = evaluateAppendfsyncHazard(fsyncInput({ aofLastWriteStatus: 'err' }));
    expect(finding?.severity).toBe('warning');
    expect(finding?.status).toBe('hazard');
    expect(finding?.message).toContain('aof_last_write_status');
  });

  it('stays silent for a healthy everysec', () => {
    expect(evaluateAppendfsyncHazard(fsyncInput({ appendfsync: 'everysec' }))).toBeNull();
  });

  it('stays silent for everysec on a single delayed-fsync rise', () => {
    expect(
      evaluateAppendfsyncHazard(
        fsyncInput({ appendfsync: 'everysec', aofDelayedFsync: 7, delayedFsyncRisingStreak: 1 }),
      ),
    ).toBeNull();
  });

  it('flags everysec when aof_delayed_fsync climbs steadily', () => {
    const finding = evaluateAppendfsyncHazard(
      fsyncInput({ appendfsync: 'everysec', aofDelayedFsync: 9, delayedFsyncRisingStreak: 2 }),
    );
    expect(finding).not.toBeNull();
    expect(finding?.id).toBe('appendfsync-everysec-backlog');
    expect(finding?.severity).toBe('warning');
    expect(finding?.status).toBe('hazard');
    expect(finding?.message).toContain('aof_delayed_fsync');
    expect(finding?.message).toContain('9');
  });

  it('returns null for no/unknown appendfsync values', () => {
    expect(evaluateAppendfsyncHazard(fsyncInput({ appendfsync: 'no' }))).toBeNull();
    expect(evaluateAppendfsyncHazard(fsyncInput({ appendfsync: null }))).toBeNull();
  });
});
