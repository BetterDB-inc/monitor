jest.mock('iovalkey', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options: Record<string, unknown>) => ({
    options,
    status: 'wait',
    on: jest.fn(),
    connect: jest.fn(() => Promise.resolve()),
    quit: jest.fn(() => Promise.resolve()),
    disconnect: jest.fn(),
  })),
}));

import Valkey from 'iovalkey';
import { UnifiedDatabaseAdapter } from '../unified.adapter';
import type { PeerCertificate } from 'tls';
import { tlsIdentityOptions, tlsServernameFor } from '../tls-servername';

describe('tlsServernameFor', () => {
  it.each([
    ['db.internal', undefined, 'db.internal'],
    ['db.internal', 'node-1.cluster.local', 'db.internal'],
    ['10.0.0.2', 'node-1.cluster.local', 'node-1.cluster.local'],
    ['fd00::2', 'node-1.cluster.local', 'node-1.cluster.local'],
    ['10.0.0.2', undefined, undefined],
    ['10.0.0.2', '', undefined],
    ['10.0.0.2', '10.0.0.2', undefined],
    ['10.0.0.2', 'fd00::2', undefined],
  ])('host %s announcing %s verifies against %s', (host, announced, expected) => {
    expect(tlsServernameFor(host, announced)).toBe(expected);
  });
});

describe('tlsIdentityOptions', () => {
  const certificateFor = (subjectaltname: string) => ({ subject: { CN: 'valkey' }, subjectaltname }) as unknown as PeerCertificate;
  const verify = (subjectaltname: string) =>
    tlsIdentityOptions('10.0.0.2', 'node-1.cluster.local').checkServerIdentity?.('node-1.cluster.local', certificateFor(subjectaltname));

  it('leaves verification to the default check when the host is a hostname', () => {
    expect(tlsIdentityOptions('db.internal', 'node-1.cluster.local')).toEqual({ servername: 'db.internal' });
  });

  it('adds nothing for an IP host without an announced hostname', () => {
    expect(tlsIdentityOptions('10.0.0.2')).toEqual({});
  });

  it('accepts a certificate issued for the announced hostname', () => {
    expect(verify('DNS:node-1.cluster.local')).toBeUndefined();
  });

  it('accepts a certificate issued for the dialled IP', () => {
    expect(verify('IP Address:10.0.0.2')).toBeUndefined();
  });

  it('rejects a certificate issued for neither the hostname nor the IP', () => {
    expect(verify('DNS:other.cluster.local, IP Address:10.0.0.9')).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });
});

describe('UnifiedDatabaseAdapter TLS servername', () => {
  beforeEach(() => jest.mocked(Valkey).mockClear());

  function tlsOptionsFor(config: { host: string; tls?: boolean; tlsServername?: string }): unknown {
    new UnifiedDatabaseAdapter({ port: 6379, username: 'default', password: 'pw', ...config });
    return (jest.mocked(Valkey).mock.calls[0] as unknown as [{ tls?: unknown }])[0].tls;
  }

  it('verifies an IP host against the announced hostname', () => {
    expect(tlsOptionsFor({ host: '10.0.0.2', tls: true, tlsServername: 'node-1.cluster.local' })).toEqual({
      servername: 'node-1.cluster.local',
      checkServerIdentity: expect.any(Function),
    });
  });

  it('sends no servername for an IP host without an announced hostname', () => {
    expect(tlsOptionsFor({ host: '10.0.0.2', tls: true })).toEqual({});
  });

  it('keeps verifying a hostname host against itself', () => {
    expect(tlsOptionsFor({ host: 'db.internal', tls: true, tlsServername: 'node-1.cluster.local' })).toEqual({ servername: 'db.internal' });
  });

  it('leaves TLS off when the connection does not use it', () => {
    expect(tlsOptionsFor({ host: '10.0.0.2', tlsServername: 'node-1.cluster.local' })).toBeUndefined();
  });
});
