import { globLiteralPrefix, type SessionNamespace } from '@betterdb/shared';

export function formatTtl(ms: number | null): string {
  if (ms === null) return 'No expiry';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function formatIdle(seconds: number | null): string {
  if (seconds === null) return 'Unknown';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function prettyArgs(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function sessionIdPrefix(
  namespace: Pick<SessionNamespace, 'pattern' | 'preset' | 'customSchema'>,
): string {
  if (namespace.preset === 'agent-cache') return '';
  if (namespace.preset === 'custom' && namespace.customSchema?.sessionTemplate) return '';
  return globLiteralPrefix(namespace.pattern);
}

export function displaySessionId(sessionId: string, prefix: string): string {
  return prefix !== '' && sessionId.length > prefix.length && sessionId.startsWith(prefix)
    ? sessionId.slice(prefix.length)
    : sessionId;
}
