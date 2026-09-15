import type { IncomingMessage } from 'http';
import { isTrustedUpgradeOrigin, originsForHost } from './trusted-origins';

function requestWith(host: string | undefined, origin: string | undefined): IncomingMessage {
  return { headers: { host, origin } } as unknown as IncomingMessage;
}

describe('originsForHost', () => {
  it('lists the host under both schemes', () => {
    expect(originsForHost('monitor.example.com:8443')).toEqual([
      'http://monitor.example.com:8443',
      'https://monitor.example.com:8443',
    ]);
  });

  it('returns nothing for an empty host', () => {
    expect(originsForHost('')).toEqual([]);
  });
});

describe('isTrustedUpgradeOrigin', () => {
  it('allows a request without an Origin header', () => {
    expect(isTrustedUpgradeOrigin(requestWith('monitor.example.com', undefined), [])).toBe(true);
  });

  it('allows an origin matching the request host under either scheme', () => {
    expect(
      isTrustedUpgradeOrigin(requestWith('monitor.example.com', 'http://monitor.example.com'), []),
    ).toBe(true);
    expect(
      isTrustedUpgradeOrigin(requestWith('monitor.example.com', 'https://monitor.example.com'), []),
    ).toBe(true);
  });

  it('matches the request host case-insensitively', () => {
    expect(
      isTrustedUpgradeOrigin(requestWith('Monitor.Example.com', 'https://monitor.example.com'), []),
    ).toBe(true);
  });

  it('allows a configured trusted origin on another host', () => {
    expect(
      isTrustedUpgradeOrigin(requestWith('localhost:3001', 'http://localhost:5173'), [
        'http://localhost:5173',
      ]),
    ).toBe(true);
  });

  it('rejects a foreign origin', () => {
    expect(
      isTrustedUpgradeOrigin(requestWith('monitor.example.com', 'https://evil.example'), [
        'http://localhost:5173',
      ]),
    ).toBe(false);
  });

  it('rejects a sibling subdomain that shares the site', () => {
    expect(
      isTrustedUpgradeOrigin(
        requestWith('acme-co.app.betterdb.com', 'https://other-co.app.betterdb.com'),
        [],
      ),
    ).toBe(false);
  });

  it('rejects the same hostname on another port', () => {
    expect(
      isTrustedUpgradeOrigin(requestWith('monitor.example.com:8443', 'https://monitor.example.com'), []),
    ).toBe(false);
  });

  it('rejects an opaque null origin', () => {
    expect(isTrustedUpgradeOrigin(requestWith('monitor.example.com', 'null'), [])).toBe(false);
  });

  it('rejects an untrusted origin when the request carries no host', () => {
    expect(isTrustedUpgradeOrigin(requestWith(undefined, 'https://evil.example'), [])).toBe(false);
  });
});
