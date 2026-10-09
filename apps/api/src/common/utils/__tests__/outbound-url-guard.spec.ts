import { BadRequestException } from '@nestjs/common';
import { promises as dns } from 'dns';
import { assertSafeOutboundUrl, isBlockedIp } from '../outbound-url-guard';

describe('outbound url guard', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
    jest.restoreAllMocks();
  });

  it('classifies addresses', () => {
    expect(isBlockedIp('10.0.0.1')).toBe(true);
    expect(isBlockedIp('10.0.0.1', true)).toBe(false);
    expect(isBlockedIp('169.254.169.254', true)).toBe(true);
    expect(isBlockedIp('fe80::1', true)).toBe(true);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('[::1]', true)).toBe(true);
    expect(isBlockedIp('127.0.0.1', true)).toBe(true);
    expect(isBlockedIp('100.100.100.200')).toBe(true);
    expect(isBlockedIp('100.63.255.255')).toBe(false);
    expect(isBlockedIp('100.128.0.1')).toBe(false);
  });

  it('rejects non-http protocols with the existing message', async () => {
    await expect(assertSafeOutboundUrl('ftp://x', { label: 'metrics URL' })).rejects.toThrow('Only HTTP and HTTPS protocols are allowed');
  });

  it('allows localhost outside production and labels the production error', async () => {
    process.env.NODE_ENV = 'development';
    await expect(assertSafeOutboundUrl('http://localhost:9400/metrics', { label: 'metrics URL' })).resolves.toBeInstanceOf(URL);
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://localhost:9400/metrics', { label: 'metrics URL' })).rejects.toThrow(
      'Cannot use localhost or 0.0.0.0 as metrics URL in production',
    );
  });

  it('lets the scraper reach private networks but never link-local', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.1.2.3', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://10.1.2.3:8000/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://10.1.2.3:8000/metrics', { label: 'metrics URL' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertSafeOutboundUrl('http://169.254.169.254/latest', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts private addresses that merely contain 127 when private networks are allowed', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.127.0.5', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://10.127.0.5:8000/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://192.168.127.10/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
  });

  it('still rejects loopback addresses when private networks are allowed', async () => {
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://127.0.0.2/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertSafeOutboundUrl('http://[::1]:9400/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertSafeOutboundUrl('http://[fe80::1]/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('unwraps IPv4-mapped IPv6 addresses before classifying them', async () => {
    expect(isBlockedIp('::ffff:169.254.169.254', true)).toBe(true);
    expect(isBlockedIp('[::ffff:a9fe:a9fe]', true)).toBe(true);
    expect(isBlockedIp('::ffff:7f00:1', true)).toBe(true);
    expect(isBlockedIp('::ffff:0a00:0001')).toBe(true);
    expect(isBlockedIp('::ffff:0a00:0001', true)).toBe(false);
    expect(isBlockedIp('::ffff:808:808')).toBe(false);
    expect(isBlockedIp('fd12::1')).toBe(true);
    expect(isBlockedIp('febf::1', true)).toBe(true);
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://[::ffff:169.254.169.254]/latest', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertSafeOutboundUrl('http://[::ffff:7f00:1]/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('treats IPv6 loopback as localhost outside production', async () => {
    process.env.NODE_ENV = 'development';
    await expect(assertSafeOutboundUrl('http://[::1]:9400/metrics', { label: 'metrics URL' })).resolves.toBeInstanceOf(URL);
  });

  it('does not resolve DNS for IP literals', async () => {
    process.env.NODE_ENV = 'production';
    const resolve = jest.spyOn(dns, 'lookup');
    await expect(assertSafeOutboundUrl('http://10.1.2.3:8000/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://8.8.8.8/x', { label: 'webhook URL' })).resolves.toBeInstanceOf(URL);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a DNS answer in loopback space even when private networks are allowed', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toThrow('Metrics URL resolves to blocked IP address: 127.0.0.1');
  });

  it('rejects a DNS answer in link-local space even when private networks are allowed', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toThrow('Metrics URL resolves to blocked IP address: 169.254.169.254');
  });

  it('uses the label in the remaining messages', async () => {
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://10.0.0.1/x', { label: 'webhook URL' })).rejects.toThrow('Cannot use private IP addresses as webhook URL');
    await expect(assertSafeOutboundUrl('not a url', { label: 'webhook URL' })).rejects.toThrow('Invalid webhook URL');
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.9.9.9', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://example.com/x', { label: 'webhook URL' })).rejects.toThrow('Webhook URL resolves to blocked IP address: 10.9.9.9');
    jest.spyOn(dns, 'lookup').mockRejectedValue(new Error('nx'));
    await expect(assertSafeOutboundUrl('http://example.com/x', { label: 'webhook URL' })).rejects.toThrow('Failed to resolve webhook URL hostname');
  });

  it('checks DNS answers outside production too', async () => {
    process.env.NODE_ENV = 'development';
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://metadata.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toThrow('Metrics URL resolves to blocked IP address: 169.254.169.254');
  });

  it('rejects a hostname whose AAAA answer is blocked', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: 'fe80::1', family: 6 },
    ] as any);
    await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toThrow('Metrics URL resolves to blocked IP address: fe80::1');
  });
});
