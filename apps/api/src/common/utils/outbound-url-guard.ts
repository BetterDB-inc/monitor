import { BadRequestException, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';
import { isIP } from 'net';

export interface OutboundUrlOptions {
  label: string;
  allowPrivateNetworks?: boolean;
}

const logger = new Logger('OutboundUrlGuard');

const BLOCKED_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fe[89ab][0-9a-f]:/i,
  /^f[cd][0-9a-f]{2}:/i,
];

const ALWAYS_BLOCKED = [/^169\.254\./, /^fe[89ab][0-9a-f]:/i];

const LOOPBACK = [/^127\./, /^0\.0\.0\.0$/, /^::1?$/];

const MAPPED_DOTTED = /^::ffff:(?:0:)?(\d{1,3}(?:\.\d{1,3}){3})$/;
const MAPPED_HEX = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

const bareHost = (hostname: string) => hostname.replace(/^\[|\]$/g, '').toLowerCase();

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

export function isBlockedIp(ip: string, allowPrivateNetworks = false): boolean {
  const address = unmapIpv4(bareHost(ip));
  if (ALWAYS_BLOCKED.some((pattern) => pattern.test(address))) return true;
  if (LOOPBACK.some((pattern) => pattern.test(address))) return true;
  if (allowPrivateNetworks) return false;
  return BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(address));
}

export async function assertSafeOutboundUrl(rawUrl: string, options: OutboundUrlOptions): Promise<URL> {
  const { label, allowPrivateNetworks } = options;
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
    const isLocalhost = host === 'localhost' || LOOPBACK.some((pattern) => pattern.test(host));

    if (isLocalhost && !isProduction) {
      logger.debug(`Allowing localhost ${label} in ${process.env.NODE_ENV || 'development'} mode: ${rawUrl}`);
      return parsed;
    }

    if (parsed.hostname === 'localhost' || parsed.hostname === '0.0.0.0') {
      throw new BadRequestException(`Cannot use localhost or 0.0.0.0 as ${label} in production`);
    }

    if (isBlockedIp(parsed.hostname, allowPrivateNetworks)) {
      throw new BadRequestException(`Cannot use private IP addresses as ${label}`);
    }

    if (parsed.hostname.startsWith('127.') || parsed.hostname.includes('localhost')) {
      throw new BadRequestException('Suspicious hostname detected');
    }

    if (isProduction && !isIP(host)) {
      try {
        const addresses = await dns.resolve(parsed.hostname);
        for (const addr of addresses) {
          if (isBlockedIp(addr, allowPrivateNetworks)) {
            throw new BadRequestException(`${capitalize(label)} resolves to blocked IP address: ${addr}`);
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
