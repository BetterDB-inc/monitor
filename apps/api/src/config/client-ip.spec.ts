import type { IncomingMessage } from 'http';
import { upgradeClientIp } from './client-ip';

function makeRequest(remoteAddress: string, forwardedFor?: string): IncomingMessage {
  return {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe('upgradeClientIp', () => {
  it('uses the socket address when trust proxy is off', () => {
    const request = makeRequest('10.0.0.1', '203.0.113.9');
    expect(upgradeClientIp(request, false)).toBe('10.0.0.1');
  });

  it('uses the forwarded address when trust proxy is fully on', () => {
    const request = makeRequest('10.0.0.1', '203.0.113.9');
    expect(upgradeClientIp(request, true)).toBe('203.0.113.9');
  });

  it('falls back to the socket address when trust proxy is on but no header is set', () => {
    const request = makeRequest('10.0.0.1');
    expect(upgradeClientIp(request, true)).toBe('10.0.0.1');
  });

  it('trusts a forwarded address from a listed proxy CIDR', () => {
    const request = makeRequest('10.0.0.1', '203.0.113.9');
    expect(upgradeClientIp(request, '10.0.0.0/8')).toBe('203.0.113.9');
  });

  it('ignores a forwarded address from a peer outside the trusted range', () => {
    const request = makeRequest('192.0.2.5', '203.0.113.9');
    expect(upgradeClientIp(request, '10.0.0.0/8')).toBe('192.0.2.5');
  });
});
