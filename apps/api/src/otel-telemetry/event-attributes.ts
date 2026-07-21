/**
 * Flattens a discrete-event payload into OTel log-record attributes. Keeps
 * primitive values only (strings/numbers/booleans); nested objects and
 * undefined are dropped. Pure and SDK-free so it can be unit-tested directly.
 */
export function buildEventAttributes(
  eventName: string,
  attributes: Record<string, unknown>,
  connectionId?: string,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = { 'event.name': eventName };
  if (connectionId) {
    result.connection_id = connectionId;
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}
