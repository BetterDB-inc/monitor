import { isBetterDbClientName } from '../own-clients';

describe('isBetterDbClientName', () => {
  it.each([
    'BetterDB-Monitor',
    'BetterDB-Monitor-Node-aafa23fc',
    'BetterDB-Monitor-keyscan',
    'BetterDB-Agent',
    'BetterDB-CLI',
  ])('matches %s', (name) => {
    expect(isBetterDbClientName(name)).toBe(true);
  });

  it.each(['', undefined, 'operator-sim', 'BetterDB-Migration-Source', 'BetterDB-Monitorx'])(
    'does not match %s',
    (name) => {
      expect(isBetterDbClientName(name)).toBe(false);
    },
  );
});
