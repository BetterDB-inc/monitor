import { BadRequestException, Logger } from '@nestjs/common';
import { isCloudMode } from '@app/common/utils/cloud-mode';
import { isTrueFlag } from '@app/config/env-normalize';
import { assertSafeOutboundUrl, BlockedAddressError, guardedLookup } from '@app/common/utils/outbound-url-guard';
import { pinnedRequest, UnexpectedStatusError } from '@app/common/utils/pinned-request';

export const SCRAPE_TIMEOUT_MS = 5_000;
export const SCRAPE_MAX_BYTES = 5 * 1024 * 1024;

export class ScrapeError extends Error {}

export const UNDECRYPTABLE_AUTH = 'auth header could not be decrypted';

export interface MetricsRequestInit {
  signal: AbortSignal;
  headers: Record<string, string>;
}

export type MetricsFetch = (url: string, init: MetricsRequestInit) => Promise<Response>;

export const pinnedFetch: MetricsFetch = (url, init) =>
  pinnedRequest(url, { ...init, lookup: guardedLookup({ label: 'metrics URL', allowPrivateNetworks: scrapeAllowsPrivateNetworks() }) });

function connectError(error: unknown): ScrapeError {
  if (error instanceof ScrapeError) return error;
  if (error instanceof BlockedAddressError || error instanceof UnexpectedStatusError) return new ScrapeError(error.message);
  const { name, code } = (error ?? {}) as { name?: string; code?: string };
  if (name === 'TimeoutError' || name === 'AbortError') return new ScrapeError('timeout');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ScrapeError(`DNS lookup failed (${code})`);
  return new ScrapeError('connection failed');
}

const BLOCK_PRIVATE_ON = new Set(['1', 'yes', 'on']);
const BLOCK_PRIVATE_OFF = new Set(['', 'false', '0', 'no', 'off']);
const warnedBlockPrivateValues = new Set<string>();
const logger = new Logger('KvCacheMetricsFetch');

function blockPrivateFlag(): boolean {
  const raw = process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (isTrueFlag(value) || BLOCK_PRIVATE_ON.has(value)) return true;
  if (BLOCK_PRIVATE_OFF.has(value)) return false;
  if (!warnedBlockPrivateValues.has(value)) {
    warnedBlockPrivateValues.add(value);
    logger.warn(`Unrecognised KV_CACHE_SCRAPE_BLOCK_PRIVATE value "${raw.trim()}"; blocking private scrape targets`);
  }
  return true;
}

export function scrapeAllowsPrivateNetworks(): boolean {
  return !isCloudMode() && !blockPrivateFlag();
}

async function reject(response: Response, message: string): Promise<never> {
  await response.body?.cancel().catch(() => undefined);
  throw new ScrapeError(message);
}

async function readCapped(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > SCRAPE_MAX_BYTES) return reject(response, 'response too large');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SCRAPE_MAX_BYTES) {
      await reader.cancel();
      throw new ScrapeError('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchMetricsText(url: string, authHeader: string | null, fetchImpl: MetricsFetch = pinnedFetch): Promise<string> {
  try {
    await assertSafeOutboundUrl(url, { label: 'metrics URL', allowPrivateNetworks: scrapeAllowsPrivateNetworks(), resolveDns: 'never' });
  } catch (error) {
    throw new ScrapeError(error instanceof BadRequestException ? error.message : 'blocked address');
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
      headers: { Accept: 'text/plain', ...(authHeader ? { Authorization: authHeader } : {}) },
    });
  } catch (error) {
    throw connectError(error);
  }
  if (response.status >= 300 && response.status < 400) await reject(response, `redirect not followed (HTTP ${response.status})`);
  if (!response.ok) await reject(response, `HTTP ${response.status}`);
  try {
    return await readCapped(response);
  } catch (error) {
    if (error instanceof ScrapeError) throw error;
    const name = (error as Error)?.name;
    throw new ScrapeError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'connection failed');
  }
}
