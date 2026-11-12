import type Valkey from 'iovalkey';
import type { DatabasePort } from '../../common/interfaces/database-port.interface';
import { MetricsParser } from '../../database/parsers/metrics.parser';
import type { CommandAnalysis } from '@betterdb/shared';

export interface CommandLogSample {
  command: string[];
  clientName?: string;
}

export async function analyzeCommands(
  adapter: DatabasePort,
): Promise<CommandAnalysis> {
  const { analysis } = await collectCommandAnalysis(adapter);
  return analysis;
}

export async function collectCommandAnalysis(
  adapter: DatabasePort,
): Promise<{ analysis: CommandAnalysis; entries: CommandLogSample[] }> {
  const result: CommandAnalysis = {
    sourceUsed: 'unavailable',
    topCommands: [],
  };

  const capabilities = adapter.getCapabilities();
  let entries: CommandLogSample[] = [];

  // Try COMMANDLOG first
  if (capabilities.hasCommandLog) {
    try {
      entries = toSamples(await adapter.getCommandLog(200));
      result.sourceUsed = 'commandlog';
    } catch {
      // Fall through to slowlog
    }
  }

  // Fallback to SLOWLOG
  if (result.sourceUsed === 'unavailable') {
    try {
      entries = toSamples(await adapter.getSlowLog(128));
      result.sourceUsed = 'slowlog';
    } catch {
      // Both unavailable
      return { analysis: result, entries: [] };
    }
  }

  const commandNames = entries.map(e => {
    return e.command.length > 0 ? String(e.command[0]).toUpperCase() : '';
  }).filter(Boolean);

  // Top commands
  const counts = new Map<string, number>();
  for (const cmd of commandNames) {
    counts.set(cmd, (counts.get(cmd) ?? 0) + 1);
  }
  result.topCommands = Array.from(counts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  return { analysis: result, entries };
}

export async function collectNodeCommandEntries(
  clients: Valkey[],
  hasCommandLog: boolean,
): Promise<{ entries: CommandLogSample[]; unreadNodes: number }> {
  const perNode = await Promise.all(clients.map(async (client) => {
    if (hasCommandLog) {
      try {
        const raw = await client.call('COMMANDLOG', 'GET', 200, 'slow');
        return toSamples(MetricsParser.parseCommandLog(raw as unknown[]));
      } catch {
        return readSlowLog(client);
      }
    }
    return readSlowLog(client);
  }));
  return {
    entries: perNode.flatMap((samples) => samples ?? []),
    unreadNodes: perNode.filter((samples) => samples === null).length,
  };
}

async function readSlowLog(client: Valkey): Promise<CommandLogSample[] | null> {
  try {
    const raw = await client.call('SLOWLOG', 'GET', 128);
    return toSamples(MetricsParser.parseSlowLog(raw as unknown[]));
  } catch {
    return null;
  }
}

function toSamples(entries: Array<{ command?: string[]; clientName?: string }>): CommandLogSample[] {
  return entries.map(e => {
    const sample: CommandLogSample = { command: (e.command ?? []).map(String) };
    if (e.clientName !== undefined) sample.clientName = e.clientName;
    return sample;
  });
}
