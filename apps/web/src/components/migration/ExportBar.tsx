import type { MigrationAnalysisResult } from '@betterdb/shared';

interface Props {
  job: MigrationAnalysisResult;
  phase?: string;
}

export function ExportBar({ job, phase }: Props) {
  if (phase === 'executing') return null;

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `betterdb-migration-${job.sourceConnectionName ?? 'unknown'}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex gap-2 print:hidden">
      <button
        onClick={handleExportJson}
        className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted"
      >
        Export JSON
      </button>
      <button
        onClick={() => window.print()}
        className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted"
      >
        Print / Save PDF
      </button>
    </div>
  );
}
