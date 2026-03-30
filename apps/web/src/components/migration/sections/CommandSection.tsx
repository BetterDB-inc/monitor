import type { MigrationAnalysisResult } from '@betterdb/shared';

interface Props {
  job: MigrationAnalysisResult;
}

const SOURCE_LABELS: Record<string, string> = {
  commandlog: 'COMMANDLOG (Valkey 8.1+)',
  slowlog: 'SLOWLOG (fallback)',
  unavailable: 'Unavailable — command history not accessible on this instance.',
};

export function CommandSection({ job }: Props) {
  const cmd = job.commandAnalysis;

  if (!cmd || cmd.topCommands.length === 0) {
    return null;
  }

  return (
    <section className="bg-card border rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-4">Command Analysis</h2>

      {cmd.topCommands.length > 0 && (
        <div className="overflow-auto max-h-80">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="pb-2">Command</th>
                <th className="pb-2">Occurrences</th>
              </tr>
            </thead>
            <tbody>
              {cmd.topCommands.map(({ command, count }) => (
                <tr key={command} className="border-b">
                  <td className="py-1.5 font-mono text-xs">{command}</td>
                  <td className="py-1.5">{count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-3">
        Command data sourced from: {SOURCE_LABELS[cmd.sourceUsed] ?? cmd.sourceUsed}
      </p>
    </section>
  );
}
