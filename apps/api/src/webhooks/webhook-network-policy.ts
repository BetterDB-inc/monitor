import { Logger } from '@nestjs/common';
import { isCloudMode } from '../common/utils/cloud-mode';
import { parseAllowedCidrs, parseAllowedHosts, type PrivateNetworkPolicy } from '../common/utils/outbound-url-guard';

const HINT = 'allow it with WEBHOOK_ALLOWED_PRIVATE_CIDRS or WEBHOOK_ALLOWED_PRIVATE_HOSTS (see docs/webhooks.md)';

const logger = new Logger('WebhookNetworkPolicy');

let cached: { key: string; policy: PrivateNetworkPolicy | undefined } | undefined;

/**
 * The private receivers webhooks may reach, from WEBHOOK_ALLOWED_PRIVATE_CIDRS
 * and WEBHOOK_ALLOWED_PRIVATE_HOSTS. Undefined when nothing is allowed, which
 * is the default, and always in cloud mode. Built once per configuration.
 */
export function webhookNetworkPolicy(): PrivateNetworkPolicy | undefined {
  const cidrs = process.env.WEBHOOK_ALLOWED_PRIVATE_CIDRS ?? '';
  const hosts = process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS ?? '';
  const cloud = isCloudMode();
  const key = JSON.stringify([cloud, cidrs, hosts]);
  if (cached?.key === key) return cached.policy;

  let policy: PrivateNetworkPolicy | undefined;
  if (cloud) {
    if (cidrs.trim() || hosts.trim()) {
      logger.warn('WEBHOOK_ALLOWED_PRIVATE_CIDRS and WEBHOOK_ALLOWED_PRIVATE_HOSTS are ignored in cloud mode');
    }
  } else {
    const allowedCidrs = parseAllowedCidrs(cidrs);
    const allowedHosts = parseAllowedHosts(hosts);
    if (allowedCidrs || allowedHosts.length > 0) policy = { allowedCidrs, allowedHosts };
  }
  cached = { key, policy };
  return policy;
}

/** Appended to a "private address" rejection; cloud mode has no allowlist to point at. */
export function webhookPrivateHint(): string | undefined {
  return isCloudMode() ? undefined : HINT;
}
