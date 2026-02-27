export function extractPattern(key: string): string {
  const parts = key.split(/[:._-]/);
  const patternParts = parts.map((part) => {
    if (/^\d+$/.test(part)) return '*';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return '*';
    if (/^[0-9a-f]{24}$/i.test(part)) return '*';
    if (/^[0-9a-f]{32,}$/i.test(part)) return '*';
    return part;
  });
  return patternParts.join(':');
}
