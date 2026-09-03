import { checkMemberReadOnly, MEMBER_DENIED_MESSAGE } from '@betterdb/shared';

describe('checkMemberReadOnly', () => {
  it.each([
    ['CONFIG', 'GET'],
    ['ACL', 'LIST'],
    ['DEBUG', 'OBJECT'],
    ['CLIENT', 'LIST'],
    ['CONFIG', undefined],
  ])('denies %s %s even though safe mode allows it', (command, subCommand) => {
    expect(checkMemberReadOnly(command, subCommand)).toBe(MEMBER_DENIED_MESSAGE);
  });

  it('allows plain read commands', () => {
    expect(checkMemberReadOnly('INFO')).toBeNull();
    expect(checkMemberReadOnly('PING')).toBeNull();
    expect(checkMemberReadOnly('SLOWLOG', 'GET')).toBeNull();
  });

  it('falls back to the safe-mode message for write commands', () => {
    expect(checkMemberReadOnly('SET')).toBe('Command SET is not allowed in safe mode.');
  });
});
