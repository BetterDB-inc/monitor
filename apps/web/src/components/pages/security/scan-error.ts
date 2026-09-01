const CONNECTION_HINT = /\s*Use GET \/connections to list available connections\.?/;
const MISSING_CONNECTION = /^Connection '[^']*' not found/;
const UNREACHABLE_PREFIX = 'No node in this connection could be scanned: ';

export const MISSING_CONNECTION_MESSAGE =
  'This connection no longer exists. Choose another connection to scan.';

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
