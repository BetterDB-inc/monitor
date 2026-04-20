export interface CommandStatsSample {
  calls: number;
  usec: number;
  usecPerCall: number;
  rejectedCalls: number;
  failedCalls: number;
}

export function parseCommandStatsSection(
  section: Record<string, string> | undefined,
): Record<string, CommandStatsSample> {
  const result: Record<string, CommandStatsSample> = {};
  if (!section) return result;

  for (const [key, value] of Object.entries(section)) {
    if (!key.startsWith('cmdstat_')) continue;
    const command = key.slice('cmdstat_'.length).toLowerCase();

    const fields: Record<string, number> = {};
    for (const pair of value.split(',')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      const n = Number(v);
      if (!isNaN(n)) fields[k] = n;
    }

    result[command] = {
      calls: fields.calls ?? 0,
      usec: fields.usec ?? 0,
      usecPerCall: fields.usec_per_call ?? 0,
      rejectedCalls: fields.rejected_calls ?? 0,
      failedCalls: fields.failed_calls ?? 0,
    };
  }

  return result;
}
