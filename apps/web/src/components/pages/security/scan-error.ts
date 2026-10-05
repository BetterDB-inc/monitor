import { ApiError } from '../../../api/client';

const CONNECTION_HINT = /\s*Use GET \/connections to list available connections\.?/;
const MISSING_CONNECTION = /^Connection '[^']*' not found/;
const UNREACHABLE_PREFIX = 'No node in this connection could be scanned: ';

export const MISSING_CONNECTION_MESSAGE =
  'This connection no longer exists. Choose another connection to scan.';

export const DATASET_UNAVAILABLE_MESSAGE = 'CVE dataset is not available yet';

export const CVE_DISABLED_MESSAGE = 'CVE inspection is turned off on this install';

export interface FailedNode {
  address: string;
  reason: string;
}

export interface ScanFailure {
  summary: string;
  nodes: FailedNode[];
}

export function scanErrorMessage(error: Error | null | undefined, fallback: string): string {
  if (error === null || error === undefined) {
    return fallback;
  }

  const message = error.message.replace(CONNECTION_HINT, '').trim();

  if (message.length === 0) {
    return fallback;
  }

  if (MISSING_CONNECTION.test(message)) {
    return MISSING_CONNECTION_MESSAGE;
  }

  return message;
}

function parseNode(entry: string): FailedNode | null {
  const separator = entry.indexOf(': ');

  if (separator <= 0) {
    return null;
  }

  const address = entry.slice(0, separator).trim();
  const reason = entry.slice(separator + 2).trim();

  if (address.length === 0 || reason.length === 0) {
    return null;
  }

  return { address, reason };
}

function parseNodes(detail: string): FailedNode[] {
  const nodes: FailedNode[] = [];

  for (const entry of detail.split('; ')) {
    const node = parseNode(entry);

    if (node === null) {
      return [];
    }

    nodes.push(node);
  }

  return nodes;
}

export function parseScanFailure(error: Error | null | undefined, fallback: string): ScanFailure {
  const summary = scanErrorMessage(error, fallback);

  if (summary.startsWith(UNREACHABLE_PREFIX) === false) {
    return { summary, nodes: [] };
  }

  const nodes = parseNodes(summary.slice(UNREACHABLE_PREFIX.length));

  if (nodes.length === 0) {
    return { summary, nodes: [] };
  }

  return { summary: 'No node in this connection could be scanned.', nodes };
}

export const VERSION_PENDING_CODE = 'cve_version_pending';

export type ScanEngineProduct = 'redis' | 'valkey';

export interface VersionPending {
  product: ScanEngineProduct;
  attribute: string;
}

export function versionPendingOf(error: Error | null | undefined): VersionPending | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }

  const payload = error.payload;

  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const body = payload as Record<string, unknown>;

  if (body.code !== VERSION_PENDING_CODE) {
    return null;
  }

  const product: ScanEngineProduct = body.product === 'valkey' ? 'valkey' : 'redis';
  const attribute = typeof body.attribute === 'string' ? body.attribute : `${product}.version`;

  return { product, attribute };
}
