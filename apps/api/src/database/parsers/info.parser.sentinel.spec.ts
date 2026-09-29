import { InfoParser } from './info.parser';

describe('InfoParser.isSentinelMode', () => {
  it.each(['server_mode', 'redis_mode', 'valkey_mode'])('reads %s', (field) => {
    expect(InfoParser.isSentinelMode({ [field]: 'sentinel' })).toBe(true);
  });

  it('is false for standalone and cluster', () => {
    expect(InfoParser.isSentinelMode({ server_mode: 'standalone' })).toBe(false);
    expect(InfoParser.isSentinelMode({ redis_mode: 'cluster' })).toBe(false);
  });
});
