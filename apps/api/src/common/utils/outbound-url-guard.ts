import { BadRequestException, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';
import { BlockList, isIP, type LookupFunction } from 'net';

/**
 * An explicit allowlist of private targets. Narrower than allowPrivateNetworks:
 * loopback is reachable only through a listed CIDR, never through a hostname.
 */
export interface PrivateNetworkPolicy {
  allowedCidrs?: BlockList;
  /** Lower-cased exact names and '*.suffix' patterns. */
  allowedHosts?: string[];
}

export interface OutboundUrlOptions {
  label: string;
  allowPrivateNetworks?: boolean;
  privateNetworkPolicy?: PrivateNetworkPolicy;
  /** Appended to the error when a URL is rejected only for being private. */
  privateHint?: string;
  resolveDns?: 'always' | 'production' | 'never';
}

export class BlockedAddressError extends Error {}

const logger = new Logger('OutboundUrlGuard');

const BLOCKED_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^169\.254\./,
  /^::1?$/,
  /^0\./,
  /^fe[89ab][0-9a-f]:/i,
  /^f[cd][0-9a-f]{2}:/i,
];

const ALWAYS_BLOCKED = [/^169\.254\./, /^fe[89ab][0-9a-f]:/i, /^fd00:ec2::254$/, /^100\.100\.100\.200$/, /^192\.0\.0\.192$/];

const LOOPBACK = [/^127\./, /^0\./, /^::1?$/];

const MAPPED_DOTTED = /^::ffff:(?:0:)?(\d{1,3}(?:\.\d{1,3}){3})$/;
const MAPPED_HEX = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

const bareHost = (hostname: string) => hostname.replace(/^\[|\]$/g, '').toLowerCase();

function canonicalIp(ip: string): string {
  const address = bareHost(ip);
  if (isIP(address) !== 6) return address;
  try {
    return bareHost(new URL(`http://[${address}]`).hostname);
  } catch {
    return address;
  }
}

function unmapIpv4(address: string): string {
  const dotted = MAPPED_DOTTED.exec(address);
  if (dotted) return dotted[1];
  const hex = MAPPED_HEX.exec(address);
  if (!hex) return address;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const isLocalhostName = (hostname: string) => /(^|\.)localhost\.?$/.test(hostname);

function blockedAddressMessage(label: string, hostname: string, address: string): string {
  logger.warn(`${capitalize(label)} ${hostname} resolves to blocked IP address ${address}`);
  return `${capitalize(label)} resolves to a blocked address`;
}

const isAlwaysBlocked = (address: string) => ALWAYS_BLOCKED.some((pattern) => pattern.test(address));

function matchesAllowedHost(patterns: string[] = [], hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return patterns.some((pattern) =>
    pattern.startsWith('*.') ? host.length > pattern.length - 1 && host.endsWith(pattern.slice(1)) : host === pattern,
  );
}

function policyAllows(policy: PrivateNetworkPolicy, address: string, hostname?: string): boolean {
  const version = isIP(address);
  if (version && policy.allowedCidrs?.check(address, version === 4 ? 'ipv4' : 'ipv6')) return true;
  if (!hostname || LOOPBACK.some((pattern) => pattern.test(address))) return false;
  return matchesAllowedHost(policy.allowedHosts, hostname);
}

/**
 * `allow` is `true` for every private address (existing callers) or a policy
 * that allows only the listed ones. `hostname` is the name the address was
 * resolved from, used for the policy's host patterns.
 */
export function isBlockedIp(ip: string, allow: boolean | PrivateNetworkPolicy = false, hostname?: string): boolean {
  const address = unmapIpv4(canonicalIp(ip));
  if (isAlwaysBlocked(address)) return true;
  if (allow === true) return false;
  if (!BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(address))) return false;
  return !allow || !policyAllows(allow, address, hostname);
}

function isLoopback(ip: string): boolean {
  const address = unmapIpv4(canonicalIp(ip));
  return LOOPBACK.some((pattern) => pattern.test(address));
}

const allowance = (options: Pick<OutboundUrlOptions, 'allowPrivateNetworks' | 'privateNetworkPolicy'>) =>
  options.allowPrivateNetworks || options.privateNetworkPolicy || false;

// Mirrors ALWAYS_BLOCKED: an allowlist entry may not overlap any of these.
const ALWAYS_BLOCKED_CIDRS = ['169.254.0.0/16', 'fe80::/10', 'fd00:ec2::254/128', '100.100.100.200/32', '192.0.0.192/32'];

const splitList = (raw: string) =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

function parseCidr(entry: string) {
  const [address, prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (!version || rest.length > 0 || !/^\d{1,3}$/.test(prefix ?? '') || Number(prefix) > (version === 4 ? 32 : 128)) {
    throw new Error(`"${entry}" is not a valid CIDR (expected e.g. 10.244.0.0/16)`);
  }
  const family = version === 4 ? ('ipv4' as const) : ('ipv6' as const);
  const only = new BlockList();
  only.addSubnet(address, Number(prefix), family);
  return { address, prefix: Number(prefix), family, only };
}

/**
 * Parses a comma-separated CIDR allowlist. Throws on a malformed entry and on
 * one that overlaps a metadata or link-local range, so a typo never becomes an
 * "allow nothing" or "allow everything" list.
 */
export function parseAllowedCidrs(raw = ''): BlockList | undefined {
  const entries = splitList(raw);
  if (entries.length === 0) return undefined;
  const allowed = new BlockList();
  const blocked = ALWAYS_BLOCKED_CIDRS.map(parseCidr);
  for (const entry of entries) {
    const cidr = parseCidr(entry);
    // Two CIDRs overlap exactly when one contains the other's network address.
    const overlaps = blocked.some(
      (range) => range.only.check(cidr.address, cidr.family) || cidr.only.check(range.address, range.family),
    );
    if (overlaps) {
      throw new Error(`"${entry}" overlaps a cloud metadata or link-local range, which can never be allowed`);
    }
    allowed.addSubnet(cidr.address, cidr.prefix, cidr.family);
  }
  return allowed;
}

const HOST_LABEL = '[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?';
const HOST_PATTERN = new RegExp(`^(\\*\\.)?${HOST_LABEL}(\\.${HOST_LABEL})*$`);

/** Parses a comma-separated list of exact hostnames and '*.suffix' patterns. */
export function parseAllowedHosts(raw = ''): string[] {
  return splitList(raw).map((entry) => {
    const host = entry.toLowerCase().replace(/\.$/, '');
    if (isIP(bareHost(host)) || !HOST_PATTERN.test(host)) {
      throw new Error(`"${entry}" is not a valid hostname pattern (expected e.g. relay.internal or *.svc.cluster.local)`);
    }
    return host;
  });
}

export async function assertSafeOutboundUrl(rawUrl: string, options: OutboundUrlOptions): Promise<URL> {
  const { label, allowPrivateNetworks, privateHint, resolveDns = 'always' } = options;
  const allow = allowance(options);
  const hint = (address: string) => (privateHint && !isAlwaysBlocked(unmapIpv4(canonicalIp(address))) ? `; ${privateHint}` : '');
  try {
    const parsed = new URL(rawUrl);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new BadRequestException('Only HTTP and HTTPS protocols are allowed');
    }

    if (parsed.username || parsed.password) {
      logger.warn(`${capitalize(label)} contains credentials, consider using custom headers instead: ${parsed.hostname}`);
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const host = unmapIpv4(bareHost(parsed.hostname));
    const isLocalhost =
      host === 'localhost' || (isIP(host) !== 0 && LOOPBACK.some((pattern) => pattern.test(host)));

    if (isLocalhost && (!isProduction || allowPrivateNetworks)) {
      logger.debug(`Allowing localhost ${label} in ${process.env.NODE_ENV || 'development'} mode: ${parsed.host}`);
      return parsed;
    }

    if (parsed.hostname === 'localhost' || parsed.hostname === '0.0.0.0') {
      throw new BadRequestException(`Cannot use localhost or 0.0.0.0 as ${label} in production`);
    }

    if (isIP(host) && isBlockedIp(host, allow)) {
      throw new BadRequestException(`Cannot use private IP addresses as ${label}${hint(host)}`);
    }

    if (!isIP(host) && !allowPrivateNetworks && (parsed.hostname.startsWith('127.') || isLocalhostName(host))) {
      throw new BadRequestException('Suspicious hostname detected');
    }

    if (!isIP(host) && resolveDns !== 'never' && (resolveDns !== 'production' || isProduction)) {
      try {
        const answers = await dns.lookup(host, { all: true, verbatim: true });
        for (const { address: addr } of answers) {
          if (isBlockedIp(addr, allow, host)) {
            throw new BadRequestException(`${blockedAddressMessage(label, host, addr)}${hint(addr)}`);
          }
        }
      } catch (dnsError: any) {
        if (dnsError instanceof BadRequestException) {
          throw dnsError;
        }
        logger.warn(`Failed to resolve DNS for ${label}: ${parsed.hostname}`);
        throw new BadRequestException(`Failed to resolve ${label} hostname`);
      }
    }

    return parsed;
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error;
    }
    throw new BadRequestException(`Invalid ${label}`);
  }
}

type ConnectOptions = Omit<OutboundUrlOptions, 'resolveDns' | 'privateHint'>;

// The connect-time rule: outside production loopback stays reachable, as in assertSafeOutboundUrl.
function isBlockedAtConnect(address: string, options: ConnectOptions, hostname?: string): boolean {
  const allowLoopback = options.allowPrivateNetworks || process.env.NODE_ENV !== 'production';
  return isBlockedIp(address, allowance(options), hostname) && !(allowLoopback && isLoopback(address));
}

/**
 * Node skips the lookup for an IP-literal host, so guardedLookup never sees it.
 * Call this before connecting to apply the same rule to those URLs.
 */
export function assertConnectableIpLiteral(rawUrl: string, options: ConnectOptions): void {
  const host = bareHost(new URL(rawUrl).hostname);
  if (isIP(host) && isBlockedAtConnect(host, options)) {
    throw new BlockedAddressError(blockedAddressMessage(options.label, host, host));
  }
}

export function guardedLookup(options: ConnectOptions): LookupFunction {
  const { label } = options;
  return (hostname, lookupOptions, callback) => {
    dns.lookup(hostname, { family: lookupOptions.family, hints: lookupOptions.hints, all: true, verbatim: true }).then(
      (answers) => {
        const blocked = answers.find(({ address }) => isBlockedAtConnect(address, options, hostname));
        if (blocked) {
          callback(new BlockedAddressError(blockedAddressMessage(label, hostname, blocked.address)), '', 0);
        } else if (answers.length === 0) {
          callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
        } else if (lookupOptions.all) {
          (callback as unknown as (error: null, addresses: typeof answers) => void)(null, answers);
        } else {
          callback(null, answers[0].address, answers[0].family);
        }
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 0),
    );
  };
}
