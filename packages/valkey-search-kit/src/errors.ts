/**
 * Classify an error as a Valkey Search "index does not exist" error.
 * Matches the message variants emitted across Valkey Search / RediSearch
 * versions, case-insensitively. Non-Error values never match.
 */
export function isIndexNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return (
    msg.includes('unknown index name') || msg.includes('no such index') || msg.includes('not found')
  );
}
