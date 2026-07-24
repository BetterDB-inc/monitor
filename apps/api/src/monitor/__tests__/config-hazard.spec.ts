import { evaluateAclAofHazard, ConfigHazardInput } from '../config-hazard';

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
