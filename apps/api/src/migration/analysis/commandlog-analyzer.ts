import type { DatabasePort } from '../../common/interfaces/database-port.interface';
import type { CommandAnalysis } from '@betterdb/shared';

export async function analyzeCommands(
  adapter: DatabasePort,
): Promise<CommandAnalysis> {
  const result: CommandAnalysis = {
    sourceUsed: 'unavailable',
    topCommands: [],
  };

  const capabilities = adapter.getCapabilities();
  let commandNames: string[] = [];

  // Try COMMANDLOG first
  if (capabilities.hasCommandLog) {
    try {
      const entries = await adapter.getCommandLog(200);
      commandNames = entries.map(e => {
        const args = e.command ?? [];
        return args.length > 0 ? String(args[0]).toUpperCase() : '';
      }).filter(Boolean);
      result.sourceUsed = 'commandlog';
    } catch {
      // Fall through to slowlog
    }
  }

  // Fallback to SLOWLOG
  if (result.sourceUsed === 'unavailable') {
    try {
      const entries = await adapter.getSlowLog(128);
      commandNames = entries.map(e => {
        const args = e.command ?? [];
        return args.length > 0 ? String(args[0]).toUpperCase() : '';
      }).filter(Boolean);
      result.sourceUsed = 'slowlog';
    } catch {
      // Both unavailable
      return result;
    }
  }

  // Top commands
  const counts = new Map<string, number>();
  for (const cmd of commandNames) {
    counts.set(cmd, (counts.get(cmd) ?? 0) + 1);
  }
  result.topCommands = Array.from(counts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  return result;
}
