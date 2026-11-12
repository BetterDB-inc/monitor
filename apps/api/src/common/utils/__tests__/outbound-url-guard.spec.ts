import { BadRequestException, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';
import {
  assertConnectableIpLiteral,
  assertSafeOutboundUrl,
  BlockedAddressError,
  guardedLookup,
  isBlockedIp,
  parseAllowedCidrs,
  parseAllowedHosts,
} from '../outbound-url-guard';

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
    expect(isBlockedIp('[::1]', true)).toBe(false);
    expect(isBlockedIp('127.0.0.1', true)).toBe(false);
    expect(isBlockedIp('[::1]')).toBe(true);
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('0.0.0.0')).toBe(true);
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

  it('lets loopback follow the private network setting in production', async () => {
    process.env.NODE_ENV = 'production';
    const resolve = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://localhost:8000/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://127.0.0.2/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://[::1]:9400/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://localhost:8000/metrics', { label: 'metrics URL' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertSafeOutboundUrl('http://127.0.0.2/metrics', { label: 'metrics URL' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertSafeOutboundUrl('http://[fe80::1]/metrics', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('lets IPv6 unique local addresses follow the private network setting', () => {
    for (const ip of ['fc00::1', 'fdff:ffff::1', 'fd12:3456::8']) {
      expect(isBlockedIp(ip, true)).toBe(false);
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it('treats the whole 0.0.0.0/8 range like loopback', async () => {
    for (const ip of ['0.0.0.0', '0.1.2.3', '0.255.255.255', '::ffff:0.1.2.3']) {
      expect(isBlockedIp(ip)).toBe(true);
      expect(isBlockedIp(ip, true)).toBe(false);
    }
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://0.1.2.3:8000/metrics', { label: 'metrics URL' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('always blocks the IPv6 metadata address', async () => {
    for (const ip of ['fd00:ec2::254', '[fd00:ec2::254]', 'FD00:EC2::254', 'fd00:0ec2:0000:0000:0000:0000:0000:0254']) {
      expect(isBlockedIp(ip, true)).toBe(true);
    }
    expect(isBlockedIp('fe00::1', true)).toBe(false);
    expect(isBlockedIp('fc0::1', true)).toBe(false);
    expect(isBlockedIp('2001:db8::1', true)).toBe(false);
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://[fd00:ec2::254]/latest/meta-data', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toThrow('Cannot use private IP addresses as metrics URL');
    await expect(assertSafeOutboundUrl('http://[fd00:ec2:0:0:0:0:0:254]/latest', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: 'fd00:ec2::254', family: 6 }] as any);
    await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toThrow('Metrics URL resolves to a blocked address');
  });

  it('always blocks other cloud metadata endpoints', () => {
    for (const ip of ['100.100.100.200', '192.0.0.192', '::ffff:100.100.100.200']) {
      expect(isBlockedIp(ip, true)).toBe(true);
    }
    expect(isBlockedIp('100.100.100.201', true)).toBe(false);
    expect(isBlockedIp('192.0.0.193', true)).toBe(false);
  });

  it('unwraps IPv4-mapped IPv6 addresses before classifying them', async () => {
    expect(isBlockedIp('::ffff:169.254.169.254', true)).toBe(true);
    expect(isBlockedIp('[::ffff:a9fe:a9fe]', true)).toBe(true);
    expect(isBlockedIp('::ffff:7f00:1')).toBe(true);
    expect(isBlockedIp('::ffff:0a00:0001')).toBe(true);
    expect(isBlockedIp('::ffff:0a00:0001', true)).toBe(false);
    expect(isBlockedIp('::ffff:808:808')).toBe(false);
    expect(isBlockedIp('fd12::1')).toBe(true);
    expect(isBlockedIp('febf::1', true)).toBe(true);
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://[::ffff:169.254.169.254]/latest', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertSafeOutboundUrl('http://[::ffff:7f00:1]/metrics', { label: 'metrics URL' })).rejects.toBeInstanceOf(BadRequestException);
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

  it('treats a DNS answer in loopback space like a private address', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL' })).rejects.toThrow('Metrics URL resolves to a blocked address');
  });

  it('resolves webhook hostnames only in production', async () => {
    process.env.NODE_ENV = 'development';
    const resolve = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '172.18.0.5', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://receiver:8080/hook', { label: 'webhook URL', resolveDns: 'production' })).resolves.toBeInstanceOf(URL);
    expect(resolve).not.toHaveBeenCalled();
    await expect(assertSafeOutboundUrl('http://10.0.0.1/hook', { label: 'webhook URL', resolveDns: 'production' })).rejects.toThrow('Cannot use private IP addresses as webhook URL');
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://receiver:8080/hook', { label: 'webhook URL', resolveDns: 'production' })).rejects.toThrow('Webhook URL resolves to a blocked address');
  });

  it('resolves DNS by default in every environment', async () => {
    for (const nodeEnv of ['development', 'production']) {
      process.env.NODE_ENV = nodeEnv;
      const resolve = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.9.9.9', family: 4 }] as any);
      await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL' })).rejects.toThrow('Metrics URL resolves to a blocked address');
      expect(resolve).toHaveBeenCalled();
      resolve.mockRestore();
    }
  });

  it('only skips the DNS pre-check for an explicit never', async () => {
    process.env.NODE_ENV = 'development';
    const resolve = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.9.9.9', family: 4 }] as any);
    for (const resolveDns of [undefined, 'always', 'sometimes']) {
      await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL', resolveDns: resolveDns as any })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('skips the DNS pre-check when resolveDns is never', async () => {
    process.env.NODE_ENV = 'production';
    const resolve = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL', resolveDns: 'never' })).resolves.toBeInstanceOf(URL);
    expect(resolve).not.toHaveBeenCalled();
    await expect(assertSafeOutboundUrl('http://10.0.0.1/x', { label: 'metrics URL', resolveDns: 'never' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies the private IP patterns only to IP literals, not hostnames', async () => {
    process.env.NODE_ENV = 'production';
    for (const url of ['http://10.metrics.example.com/x', 'http://192.168.example.com/x', 'http://fc00-metrics.example.com/x']) {
      await expect(assertSafeOutboundUrl(url, { label: 'metrics URL', resolveDns: 'never' })).resolves.toBeInstanceOf(URL);
    }
  });

  it('skips the suspicious hostname check when private networks are allowed', async () => {
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://vllm-localhost-proxy:8000/x', { label: 'metrics URL', allowPrivateNetworks: true, resolveDns: 'never' })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://app.localhost:8000/x', { label: 'metrics URL', resolveDns: 'never' })).rejects.toThrow('Suspicious hostname detected');
  });

  it('only treats localhost and its subdomains as suspicious hostnames', async () => {
    process.env.NODE_ENV = 'production';
    for (const url of ['http://notlocalhost.io/x', 'http://vllm-localhost-proxy:8000/x', 'http://localhost.example.com/x']) {
      await expect(assertSafeOutboundUrl(url, { label: 'metrics URL', resolveDns: 'never' })).resolves.toBeInstanceOf(URL);
    }
    for (const url of ['http://app.localhost/x', 'http://LOCALHOST./x', 'http://a.b.localhost./x']) {
      await expect(assertSafeOutboundUrl(url, { label: 'metrics URL', resolveDns: 'never' })).rejects.toThrow(BadRequestException);
    }
  });

  it('keeps the blocked address out of the error and logs it instead', async () => {
    process.env.NODE_ENV = 'production';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.9.9.9', family: 4 }] as any);
    const error = await assertSafeOutboundUrl('http://db.internal/x', { label: 'metrics URL' }).catch((e: Error) => e);
    expect((error as Error).message).toBe('Metrics URL resolves to a blocked address');
    expect(warn.mock.calls.flat().join(' ')).toContain('10.9.9.9');
    const { error: lookupError } = await new Promise<{ error: Error | null }>((resolve) =>
      guardedLookup({ label: 'metrics URL' })('db.internal', { all: false } as any, (e: NodeJS.ErrnoException | null) => resolve({ error: e })),
    );
    expect(lookupError?.message).toBe('Metrics URL resolves to a blocked address');
  });

  it('rejects a DNS answer in link-local space even when private networks are allowed', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toThrow('Metrics URL resolves to a blocked address');
  });

  it('uses the label in the remaining messages', async () => {
    process.env.NODE_ENV = 'production';
    await expect(assertSafeOutboundUrl('http://10.0.0.1/x', { label: 'webhook URL' })).rejects.toThrow('Cannot use private IP addresses as webhook URL');
    await expect(assertSafeOutboundUrl('not a url', { label: 'webhook URL' })).rejects.toThrow('Invalid webhook URL');
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.9.9.9', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://example.com/x', { label: 'webhook URL' })).rejects.toThrow('Webhook URL resolves to a blocked address');
    jest.spyOn(dns, 'lookup').mockRejectedValue(new Error('nx'));
    await expect(assertSafeOutboundUrl('http://example.com/x', { label: 'webhook URL' })).rejects.toThrow('Failed to resolve webhook URL hostname');
  });

  it('checks DNS answers outside production too', async () => {
    process.env.NODE_ENV = 'development';
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://metadata.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toThrow('Metrics URL resolves to a blocked address');
  });

  it('rejects a hostname whose AAAA answer is blocked', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: 'fe80::1', family: 6 },
    ] as any);
    await expect(assertSafeOutboundUrl('http://metrics.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toThrow('Metrics URL resolves to a blocked address');
  });

  describe('guardedLookup', () => {
    const run = (lookup: ReturnType<typeof guardedLookup>, host: string, all: boolean) =>
      new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
        lookup(host, { all } as any, (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => resolve({ error, address, family })),
      );

    it('returns the validated address in both callback shapes', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any);
      const lookup = guardedLookup({ label: 'metrics URL' });
      await expect(run(lookup, 'metrics.example.com', false)).resolves.toEqual({ error: null, address: '8.8.8.8', family: 4 });
      await expect(run(lookup, 'metrics.example.com', true)).resolves.toEqual({ error: null, address: [{ address: '8.8.8.8', family: 4 }], family: undefined });
    });

    it('fails the connection when any answer is blocked', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ] as any);
      const { error } = await run(guardedLookup({ label: 'metrics URL', allowPrivateNetworks: true }), 'metrics.example.com', true);
      expect(error).toBeInstanceOf(BlockedAddressError);
      expect(error?.message).toBe('Metrics URL resolves to a blocked address');
    });

    it('applies the private network setting', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.1.2.3', family: 4 }] as any);
      expect((await run(guardedLookup({ label: 'metrics URL' }), 'h', false)).error).toBeInstanceOf(BlockedAddressError);
      expect((await run(guardedLookup({ label: 'metrics URL', allowPrivateNetworks: true }), 'h', false)).address).toBe('10.1.2.3');
    });

    it('agrees with the pre-check on loopback outside production', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
      process.env.NODE_ENV = 'development';
      await expect(assertSafeOutboundUrl('http://localhost:8000/metrics', { label: 'metrics URL' })).resolves.toBeInstanceOf(URL);
      expect((await run(guardedLookup({ label: 'metrics URL' }), 'localhost', false)).address).toBe('127.0.0.1');
      process.env.NODE_ENV = 'production';
      expect((await run(guardedLookup({ label: 'metrics URL' }), 'localhost', false)).error).toBeInstanceOf(BlockedAddressError);
    });

    it('still blocks other private answers outside production', async () => {
      process.env.NODE_ENV = 'development';
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.1.2.3', family: 4 }] as any);
      expect((await run(guardedLookup({ label: 'metrics URL' }), 'h', false)).error).toBeInstanceOf(BlockedAddressError);
    });

    it('passes DNS errors through', async () => {
      const failure = Object.assign(new Error('getaddrinfo ENOTFOUND h'), { code: 'ENOTFOUND' });
      jest.spyOn(dns, 'lookup').mockRejectedValue(failure);
      expect((await run(guardedLookup({ label: 'metrics URL' }), 'h', false)).error).toBe(failure);
    });
  });

  describe('private network policy', () => {
    const webhook = (cidrs = '', hosts = '') => ({
      label: 'webhook URL',
      privateNetworkPolicy: { allowedCidrs: parseAllowedCidrs(cidrs), allowedHosts: parseAllowedHosts(hosts) },
    });
    const resolveTo = (...addresses: string[]) =>
      jest.spyOn(dns, 'lookup').mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never);
    const run = (lookup: ReturnType<typeof guardedLookup>, host: string) =>
      new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>((resolve) =>
        lookup(host, { all: false } as never, (error: NodeJS.ErrnoException | null, address: unknown) => resolve({ error, address })),
      );

    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('allows an IP literal inside a listed CIDR and rejects one outside it', async () => {
      const options = webhook('10.244.0.0/16, fd12:3456::/32');
      await expect(assertSafeOutboundUrl('http://10.244.1.7/hook', options)).resolves.toBeInstanceOf(URL);
      await expect(assertSafeOutboundUrl('http://[fd12:3456::8]/hook', options)).resolves.toBeInstanceOf(URL);
      await expect(assertSafeOutboundUrl('http://10.245.0.1/hook', options)).rejects.toThrow('Cannot use private IP addresses as webhook URL');
      await expect(assertSafeOutboundUrl('http://8.8.8.8/hook', options)).resolves.toBeInstanceOf(URL);
    });

    it('allows a listed hostname to resolve to a private address', async () => {
      const options = webhook('', '*.svc.cluster.local, Relay.Internal.');
      resolveTo('10.96.3.4');
      await expect(assertSafeOutboundUrl('http://r.ns.svc.cluster.local/', options)).resolves.toBeInstanceOf(URL);
      await expect(assertSafeOutboundUrl('http://R.NS.SVC.cluster.local./', options)).resolves.toBeInstanceOf(URL);
      await expect(assertSafeOutboundUrl('http://relay.internal/', options)).resolves.toBeInstanceOf(URL);
      for (const url of ['http://evil.example.com/', 'http://svc.cluster.local/', 'http://a.relay.internal/', 'http://xsvc.cluster.local/']) {
        await expect(assertSafeOutboundUrl(url, options)).rejects.toThrow('Webhook URL resolves to a blocked address');
      }
    });

    it('never allows metadata or link-local addresses', async () => {
      const options = webhook('10.0.0.0/8', '*.svc.cluster.local');
      resolveTo('169.254.169.254');
      await expect(assertSafeOutboundUrl('http://r.ns.svc.cluster.local/', options)).rejects.toThrow('Webhook URL resolves to a blocked address');
      for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:169.254.169.254]/', 'http://[fd00:ec2::254]/', 'http://100.100.100.200/']) {
        await expect(assertSafeOutboundUrl(url, options)).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('keeps loopback blocked unless its CIDR is listed', async () => {
      await expect(assertSafeOutboundUrl('http://127.0.0.1:3001/', webhook('10.0.0.0/8'))).rejects.toBeInstanceOf(BadRequestException);
      await expect(assertSafeOutboundUrl('http://[::1]:3001/', webhook('10.0.0.0/8'))).rejects.toBeInstanceOf(BadRequestException);
      await expect(assertSafeOutboundUrl('http://127.0.0.1:3001/', webhook('127.0.0.0/8'))).resolves.toBeInstanceOf(URL);
      await expect(assertSafeOutboundUrl('http://[::1]:3001/', webhook('::1/128'))).resolves.toBeInstanceOf(URL);
      resolveTo('127.0.0.1');
      await expect(assertSafeOutboundUrl('http://r.ns.svc.cluster.local/', webhook('', '*.svc.cluster.local'))).rejects.toThrow(
        'Webhook URL resolves to a blocked address',
      );
      await expect(assertSafeOutboundUrl('http://r.ns.svc.cluster.local/', webhook('127.0.0.0/8'))).resolves.toBeInstanceOf(URL);
    });

    it('rejects a hostname when any answer is outside the allowlist', async () => {
      resolveTo('10.244.1.7', '10.245.0.1');
      await expect(assertSafeOutboundUrl('http://hooks.example.com/', webhook('10.244.0.0/16'))).rejects.toThrow('Webhook URL resolves to a blocked address');
    });

    it('appends the hint only when the address is merely private', async () => {
      const options = { label: 'webhook URL', privateHint: 'allow it with X' };
      await expect(assertSafeOutboundUrl('http://10.0.0.1/', options)).rejects.toThrow('Cannot use private IP addresses as webhook URL; allow it with X');
      const metadata = await assertSafeOutboundUrl('http://169.254.169.254/', options).catch((e: Error) => e);
      expect((metadata as Error).message).toBe('Cannot use private IP addresses as webhook URL');
      resolveTo('10.9.9.9');
      await expect(assertSafeOutboundUrl('http://db.internal/', options)).rejects.toThrow('Webhook URL resolves to a blocked address; allow it with X');
      resolveTo('169.254.169.254');
      const resolved = await assertSafeOutboundUrl('http://db.internal/', options).catch((e: Error) => e);
      expect((resolved as Error).message).toBe('Webhook URL resolves to a blocked address');
    });

    it('applies the same policy at connect time', async () => {
      const options = webhook('10.244.0.0/16', '*.svc.cluster.local');
      resolveTo('10.96.3.4');
      expect((await run(guardedLookup(options), 'r.ns.svc.cluster.local')).address).toBe('10.96.3.4');
      expect((await run(guardedLookup(options), 'evil.example.com')).error).toBeInstanceOf(BlockedAddressError);
      resolveTo('10.244.1.7');
      expect((await run(guardedLookup(options), 'evil.example.com')).address).toBe('10.244.1.7');
      resolveTo('10.244.1.7', '10.245.0.1');
      expect((await run(guardedLookup(options), 'hooks.example.com')).error).toBeInstanceOf(BlockedAddressError);
      resolveTo('169.254.169.254');
      expect((await run(guardedLookup(options), 'r.ns.svc.cluster.local')).error).toBeInstanceOf(BlockedAddressError);
      resolveTo('127.0.0.1');
      expect((await run(guardedLookup(options), 'r.ns.svc.cluster.local')).error).toBeInstanceOf(BlockedAddressError);
    });

    it('checks IP-literal URLs at connect time, which the lookup never sees', () => {
      const options = webhook('10.244.0.0/16');
      expect(() => assertConnectableIpLiteral('http://10.244.1.7/hook', options)).not.toThrow();
      expect(() => assertConnectableIpLiteral('http://8.8.8.8/hook', options)).not.toThrow();
      expect(() => assertConnectableIpLiteral('http://hooks.example.com/hook', options)).not.toThrow();
      expect(() => assertConnectableIpLiteral('http://10.245.0.1/hook', options)).toThrow(BlockedAddressError);
      expect(() => assertConnectableIpLiteral('http://[::ffff:169.254.169.254]/', options)).toThrow(BlockedAddressError);
      expect(() => assertConnectableIpLiteral('http://127.0.0.1:3001/', options)).toThrow(BlockedAddressError);
    });

    it('holds loopback to the policy outside production too', async () => {
      process.env.NODE_ENV = 'development';
      const hostsOnly = webhook('', '*.svc.cluster.local');
      for (const url of ['http://127.0.0.1:3001/', 'http://[::1]:3001/', 'http://0.0.0.0:3001/', 'http://localhost:3001/']) {
        await expect(assertSafeOutboundUrl(url, hostsOnly)).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(assertSafeOutboundUrl('http://localhost:3001/', hostsOnly)).rejects.toThrow('Cannot use localhost or 0.0.0.0 as webhook URL');
      await expect(assertSafeOutboundUrl('http://localhost:3001/', hostsOnly)).rejects.not.toThrow('in production');
      expect(() => assertConnectableIpLiteral('http://127.0.0.1:3001/', hostsOnly)).toThrow(BlockedAddressError);
      resolveTo('127.0.0.1');
      expect((await run(guardedLookup(hostsOnly), 'r.ns.svc.cluster.local')).error).toBeInstanceOf(BlockedAddressError);
      expect((await run(guardedLookup(hostsOnly), 'localhost')).error).toBeInstanceOf(BlockedAddressError);

      const withLoopback = webhook('127.0.0.0/8');
      await expect(assertSafeOutboundUrl('http://127.0.0.1:3001/', withLoopback)).resolves.toBeInstanceOf(URL);
      expect(() => assertConnectableIpLiteral('http://127.0.0.1:3001/', withLoopback)).not.toThrow();
      expect((await run(guardedLookup(withLoopback), 'relay.internal')).address).toBe('127.0.0.1');
    });

    it.each(['development', 'production'])('accepts 0.0.0.0 at create and connect when a CIDR lists it in %s', async (env) => {
      process.env.NODE_ENV = env;
      const listed = webhook('0.0.0.0/32');
      await expect(assertSafeOutboundUrl('http://0.0.0.0:3001/', listed)).resolves.toBeInstanceOf(URL);
      expect(() => assertConnectableIpLiteral('http://0.0.0.0:3001/', listed)).not.toThrow();
      await expect(assertSafeOutboundUrl('http://0.0.0.0:3001/', webhook('10.0.0.0/8'))).rejects.toThrow(
        'Cannot use localhost or 0.0.0.0 as webhook URL',
      );
      await expect(assertSafeOutboundUrl('http://localhost:3001/', listed)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps the development loopback exception when no policy is configured', async () => {
      process.env.NODE_ENV = 'development';
      const none = { label: 'webhook URL' };
      await expect(assertSafeOutboundUrl('http://127.0.0.1:3001/', none)).resolves.toBeInstanceOf(URL);
      await expect(assertSafeOutboundUrl('http://localhost:3001/', none)).resolves.toBeInstanceOf(URL);
      expect(() => assertConnectableIpLiteral('http://127.0.0.1:3001/', none)).not.toThrow();
      resolveTo('127.0.0.1');
      expect((await run(guardedLookup(none), 'localhost')).address).toBe('127.0.0.1');
    });

    it.each(['0.0.0.0/0', '169.254.0.0/16', '169.254.169.254/32', '100.64.0.0/10', '192.0.0.0/24', '::/0', 'fe80::/64', 'fd00::/8', '::ffff:169.254.0.0/112'])(
      'refuses the allowlist entry %s because it overlaps an always-blocked range',
      (cidr) => {
        expect(() => parseAllowedCidrs(`10.0.0.0/8,${cidr}`)).toThrow('overlaps a cloud metadata or link-local range');
      },
    );

    it.each(['10.0.0.0', '10.0.0.0/33', '10.0.0/8', 'fd12::/129', '10.0.0.0/8/8', 'relay.internal', '10.0.0.0/x'])('rejects the malformed CIDR %s', (cidr) => {
      expect(() => parseAllowedCidrs(cidr)).toThrow('is not a valid CIDR');
    });

    it.each(['*', '*.', 'a.*.local', '*relay.internal', '10.0.0.1', '[::1]', 'relay internal', 'http://relay.internal', '-relay.internal'])(
      'rejects the malformed host pattern %s',
      (host) => {
        expect(() => parseAllowedHosts(host)).toThrow('is not a valid hostname pattern');
      },
    );

    it('treats empty lists as no allowlist', () => {
      expect(parseAllowedCidrs('')).toBeUndefined();
      expect(parseAllowedCidrs(' , ')).toBeUndefined();
      expect(parseAllowedHosts(' , ')).toEqual([]);
      expect(parseAllowedHosts('*.SVC.cluster.local, relay.internal.')).toEqual(['*.svc.cluster.local', 'relay.internal']);
    });
  });

  it('resolves a hostname that starts like a loopback address instead of trusting it', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as any);
    await expect(assertSafeOutboundUrl('http://127.metrics.example.com/x', { label: 'metrics URL', allowPrivateNetworks: true })).rejects.toBeInstanceOf(BadRequestException);
  });
});
