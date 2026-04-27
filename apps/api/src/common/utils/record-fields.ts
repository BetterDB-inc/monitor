export function readIntField(record: Record<string, string>, field: string): number {
  const value = record[field];
  if (value === undefined || value === '') {
    return 0;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}
