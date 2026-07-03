// Extract the outermost JSON array from an LLM reply. Returns null when the
// reply contains no parseable array (prose, truncation, stray brackets) —
// each caller decides its own fallback (no facts, zero scores, no
// sub-queries) and keeps its own element validation.
export function extractJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}
