import { BadRequestException, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';
import { isIP, type LookupFunction } from 'net';

export interface OutboundUrlOptions {
  label: string;
  allowPrivateNetworks?: boolean;
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

export function isBlockedIp(ip: string, allowPrivateNetworks = false): boolean {
  const address = unmapIpv4(canonicalIp(ip));
  if (ALWAYS_BLOCKED.some((pattern) => pattern.test(address))) return true;
  if (allowPrivateNetworks) return false;
  return BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(address));
}

function isLoopback(ip: string): boolean {
  const address = unmapIpv4(canonicalIp(ip));
  return LOOPBACK.some((pattern) => pattern.test(address));
}

export async function assertSafeOutboundUrl(rawUrl: string, options: OutboundUrlOptions): Promise<URL> {
  const { label, allowPrivateNetworks, resolveDns = 'always' } = options;
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

    if (isIP(host) && isBlockedIp(host, allowPrivateNetworks)) {
      throw new BadRequestException(`Cannot use private IP addresses as ${label}`);
    }

    if (!allowPrivateNetworks && (parsed.hostname.startsWith('127.') || isLocalhostName(host))) {
      throw new BadRequestException('Suspicious hostname detected');
    }

    if (!isIP(host) && resolveDns !== 'never' && (resolveDns !== 'production' || isProduction)) {
      try {
        const answers = await dns.lookup(host, { all: true, verbatim: true });
        for (const { address: addr } of answers) {
          if (isBlockedIp(addr, allowPrivateNetworks)) {
            throw new BadRequestException(blockedAddressMessage(label, host, addr));
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

export function guardedLookup(options: Omit<OutboundUrlOptions, 'resolveDns'>): LookupFunction {
  const { label, allowPrivateNetworks } = options;
  return (hostname, lookupOptions, callback) => {
    dns.lookup(hostname, { family: lookupOptions.family, hints: lookupOptions.hints, all: true, verbatim: true }).then(
      (answers) => {
        const allowLoopback = allowPrivateNetworks || process.env.NODE_ENV !== 'production';
        const blocked = answers.find(({ address }) => isBlockedIp(address, allowPrivateNetworks) && !(allowLoopback && isLoopback(address)));
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
