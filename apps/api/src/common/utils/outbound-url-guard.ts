import { BadRequestException, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';

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
  /^fe80:/,
  /^fc00:/,
];

const ALWAYS_BLOCKED = [/^169\.254\./, /^fe80:/i];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function isBlockedIp(ip: string, allowPrivateNetworks = false): boolean {
  if (ALWAYS_BLOCKED.some((pattern) => pattern.test(ip))) return true;
  if (allowPrivateNetworks) return false;
  return BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(ip));
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
    const isLocalhost = parsed.hostname === 'localhost' ||
      parsed.hostname === '0.0.0.0' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname.startsWith('127.');

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

    if (parsed.hostname.includes('127.') || parsed.hostname.includes('localhost')) {
      throw new BadRequestException('Suspicious hostname detected');
    }

    if (isProduction) {
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
