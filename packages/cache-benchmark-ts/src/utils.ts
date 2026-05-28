/**
 * Recursively converts camelCase object keys to snake_case for JSON output
 * compatibility with the Python benchmark harness.
 */
export function toSnakeCase(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(toSnakeCase);
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      out[camelToSnake(key)] = toSnakeCase(value);
    }
    return out;
  }
  return obj;
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}
