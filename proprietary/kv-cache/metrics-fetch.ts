import { assertSafeOutboundUrl } from '@app/common/utils/outbound-url-guard';

export const SCRAPE_TIMEOUT_MS = 5_000;
export const SCRAPE_MAX_BYTES = 5 * 1024 * 1024;

export class ScrapeError extends Error {}

export function scrapeAllowsPrivateNetworks(): boolean {
  return process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE !== 'true';
}

async function readCapped(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > SCRAPE_MAX_BYTES) throw new ScrapeError('response too large');
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

export async function fetchMetricsText(url: string, authHeader: string | null, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    await assertSafeOutboundUrl(url, { label: 'metrics URL', allowPrivateNetworks: scrapeAllowsPrivateNetworks() });
  } catch {
    throw new ScrapeError('blocked address');
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
      headers: { Accept: 'text/plain', ...(authHeader ? { Authorization: authHeader } : {}) },
    });
  } catch (error) {
    const name = (error as Error)?.name;
    throw new ScrapeError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'connection failed');
  }
  if (response.status >= 300 && response.status < 400) throw new ScrapeError(`redirect not followed (HTTP ${response.status})`);
  if (!response.ok) throw new ScrapeError(`HTTP ${response.status}`);
  return readCapped(response);
}
