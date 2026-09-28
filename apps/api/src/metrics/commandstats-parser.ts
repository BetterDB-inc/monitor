import { InfoParser } from '../database/parsers/info.parser';

export interface CommandStatsSample {
  command: string;
  calls: number;
  usec?: number;
  usecPerCall?: number;
  rejectedCalls: number;
  failedCalls: number;
}

export function toNumber(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function optionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function parseCommandStatsSection(
  section: Record<string, string> | undefined,
): CommandStatsSample[] {
  if (!section) {
    return [];
  }

  const samples: CommandStatsSample[] = [];
  for (const [key, value] of Object.entries(section)) {
    if (!key.startsWith('cmdstat_')) {
      continue;
    }
    const command = key.slice('cmdstat_'.length).toLowerCase();
    const fields = InfoParser.parseKvLine(value, ',');

    const usec = optionalNumber(fields.usec);
    const usecPerCall = optionalNumber(fields.usec_per_call);

    samples.push({
      command,
      calls: toNumber(fields.calls),
      ...(usec !== undefined && { usec }),
      ...(usecPerCall !== undefined && { usecPerCall }),
      rejectedCalls: toNumber(fields.rejected_calls),
      failedCalls: toNumber(fields.failed_calls),
    });
  }

  return samples;
}
