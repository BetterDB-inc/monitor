// A comma-separated env value as a list of its non-empty, trimmed parts.
export function csvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
