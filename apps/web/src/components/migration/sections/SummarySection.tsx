import type { MigrationAnalysisResult } from '@betterdb/shared';
import { AlertTriangle } from 'lucide-react';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function DbBadge({ dbType, dbVersion, connectionName }: {
  dbType?: 'valkey' | 'redis';
  dbVersion?: string;
  connectionName?: string;
}) {
  const label = dbType === 'valkey' ? 'Valkey' : dbType === 'redis' ? 'Redis' : 'Unknown';
  const colorClass = dbType === 'valkey'
    ? 'bg-teal-100 text-teal-700'
    : dbType === 'redis'
      ? 'bg-red-100 text-red-700'
      : 'bg-gray-100 text-gray-700';

  return (
    <div className="flex items-center gap-2">
      <span className={`px-2 py-0.5 text-xs rounded font-medium ${colorClass}`}>
        {label}
      </span>
      <span className="text-sm font-medium">{dbVersion ?? 'Unknown'}</span>
      <span className="text-sm text-muted-foreground truncate">
        {connectionName ?? 'Unknown'}
      </span>
    </div>
  );
}

interface Props {
  job: MigrationAnalysisResult;
}

export function SummarySection({ job }: Props) {
  return (
    <section className="bg-card border rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-4">Summary</h2>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <DbBadge
          dbType={job.sourceDbType}
          dbVersion={job.sourceDbVersion}
          connectionName={job.sourceConnectionName}
        />
        <span className="text-muted-foreground font-medium">&rarr;</span>
        <DbBadge
          dbType={job.targetDbType}
          dbVersion={job.targetDbVersion}
          connectionName={job.targetConnectionName}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div>
          <p className="text-xs text-muted-foreground">Total Keys</p>
          <p className="font-medium">{(job.totalKeys ?? 0).toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Est. Memory</p>
          <p className="font-medium">~{formatBytes(job.estimatedTotalMemoryBytes ?? 0)}</p>
        </div>
      </div>

      {job.isCluster && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 mb-4">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <p className="text-sm">
            Cluster mode detected — analysis covers {job.clusterMasterCount} master nodes.
            Key count and memory are aggregated across all masters.
          </p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {(job.sampledKeys ?? 0).toLocaleString()} keys sampled out of {(job.totalKeys ?? 0).toLocaleString()} total
        {job.isCluster ? ` (${(job.sampledPerNode ?? 0).toLocaleString()} per node)` : ''}
      </p>
    </section>
  );
}
