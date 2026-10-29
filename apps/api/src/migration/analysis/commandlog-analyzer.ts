import type { DatabasePort } from '../../common/interfaces/database-port.interface';
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

function toSamples(entries: Array<{ command?: string[]; clientName?: string }>): CommandLogSample[] {
  return entries.map(e => {
    const sample: CommandLogSample = { command: (e.command ?? []).map(String) };
    if (e.clientName !== undefined) sample.clientName = e.clientName;
    return sample;
  });
}
