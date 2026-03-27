import { useState } from 'react';
import type { MigrationAnalysisResult, MigrationExecutionResult, ExecutionMode } from '@betterdb/shared';
import { Feature } from '@betterdb/shared';
import { fetchApi } from '../api/client';
import { useLicense } from '../hooks/useLicense';
import { AnalysisForm } from '../components/migration/AnalysisForm';
import { AnalysisProgressBar } from '../components/migration/AnalysisProgressBar';
import { MigrationReport } from '../components/migration/MigrationReport';
import { ExportBar } from '../components/migration/ExportBar';
import { ExecutionPanel } from '../components/migration/ExecutionPanel';
import { ValidationPanel } from '../components/migration/ValidationPanel';

type Phase = 'idle' | 'analyzing' | 'analyzed' | 'executing' | 'executed' | 'validating' | 'validated';

export function MigrationPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [validationId, setValidationId] = useState<string | null>(null);
  const [job, setJob] = useState<MigrationAnalysisResult | null>(null);
  const [executionResult, setExecutionResult] = useState<MigrationExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { hasFeature } = useLicense();

  const canExecute = hasFeature(Feature.MIGRATION_EXECUTION);
  const blockingCount = job?.blockingCount ?? 0;
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('redis_shake');

  const handleStartMigration = async () => {
    if (!job?.sourceConnectionId || !job?.targetConnectionId) return;

    const modeLabel = executionMode === 'command' ? 'command-based' : 'DUMP/RESTORE (RedisShake)';
    const warning = blockingCount > 0
      ? `\n\nWARNING: There ${blockingCount === 1 ? 'is' : 'are'} ${blockingCount} unresolved blocking issue${blockingCount !== 1 ? 's' : ''}. Proceeding may cause data loss or incompatibility.`
      : '';
    const confirmed = window.confirm(
      `This will start copying data from ${job.sourceConnectionName ?? 'source'} to ${job.targetConnectionName ?? 'target'} using ${modeLabel} mode. The target instance will receive all scanned keys.${warning}\n\nContinue?`,
    );
    if (!confirmed) return;

    try {
      const result = await fetchApi<{ id: string }>('/migration/execution', {
        method: 'POST',
        body: JSON.stringify({
          sourceConnectionId: job.sourceConnectionId,
          targetConnectionId: job.targetConnectionId,
          mode: executionMode,
        }),
      });
      setExecutionId(result.id);
      setPhase('executing');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  };

  const handleStartValidation = async () => {
    if (!job?.sourceConnectionId || !job?.targetConnectionId) return;

    try {
      const result = await fetchApi<{ id: string }>('/migration/validation', {
        method: 'POST',
        body: JSON.stringify({
          sourceConnectionId: job.sourceConnectionId,
          targetConnectionId: job.targetConnectionId,
          analysisId: analysisId ?? undefined,
          migrationStartedAt: executionResult?.startedAt,
        }),
      });
      setValidationId(result.id);
      setPhase('validating');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Migration Analysis</h1>
        <p className="text-muted-foreground mt-1">
          Analyze your source instance to assess migration readiness.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {phase === 'idle' && (
        <AnalysisForm
          onStart={(id) => {
            setAnalysisId(id);
            setPhase('analyzing');
            setError(null);
          }}
        />
      )}

      {phase === 'analyzing' && analysisId && (
        <AnalysisProgressBar
          analysisId={analysisId}
          onComplete={(result) => {
            setJob(result);
            setPhase('analyzed');
          }}
          onError={(msg) => {
            setError(msg);
            setPhase('idle');
          }}
          onCancel={() => {
            setPhase('idle');
          }}
        />
      )}

      {phase === 'analyzed' && job && (
        <>
          <ExportBar job={job} phase={phase} />
          <MigrationReport job={job} />

          {/* Mode selector + Start Migration button */}
          <div className="pt-4 border-t space-y-3">
            {canExecute && (
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium">Migration mode:</label>
                <select
                  value={executionMode}
                  onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
                  className="text-sm border rounded-md px-2 py-1 bg-background"
                >
                  <option value="redis_shake">DUMP/RESTORE (RedisShake)</option>
                  <option value="command">Command-based (cross-version compatible)</option>
                </select>
              </div>
            )}
            {!canExecute ? (
              <div>
                <button
                  disabled
                  className="px-4 py-2 text-sm rounded-lg bg-muted text-muted-foreground cursor-not-allowed inline-flex items-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                  </svg>
                  Start Migration
                </button>
                <p className="text-sm text-muted-foreground mt-2">
                  Migration execution requires a Pro license. Upgrade at betterdb.com/pricing
                </p>
              </div>
            ) : (
              <div>
                <button
                  onClick={handleStartMigration}
                  className={blockingCount > 0
                    ? 'px-4 py-2 text-sm rounded-lg border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                    : 'px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90'
                  }
                >
                  Start Migration &rarr;
                </button>
                {blockingCount > 0 && (
                  <p className="text-sm text-amber-600 mt-2">
                    {blockingCount} blocking issue{blockingCount !== 1 ? 's' : ''} detected — proceed at your own risk.
                  </p>
                )}
              </div>
            )}
          </div>

          <button
            onClick={() => {
              setPhase('idle');
              setJob(null);
              setAnalysisId(null);
              setExecutionId(null);
              setValidationId(null);
              setExecutionResult(null);
            }}
            className="mt-4 px-4 py-2 text-sm border rounded-lg hover:bg-muted"
          >
            Run another analysis
          </button>
        </>
      )}

      {phase === 'executing' && job && executionId && (
        <>
          <MigrationReport job={job} />
          <ExecutionPanel
            executionId={executionId}
            onStopped={async () => {
              // Fetch final execution result to get startedAt for validation
              try {
                const result = await fetchApi<MigrationExecutionResult>(`/migration/execution/${executionId}`);
                setExecutionResult(result);
              } catch { /* ignore */ }
              setPhase('executed');
            }}
          />
        </>
      )}

      {phase === 'executed' && job && executionId && (
        <>
          <ExportBar job={job} phase={phase} />
          <MigrationReport job={job} />
          <ExecutionPanel
            executionId={executionId}
            onStopped={() => {/* already stopped */}}
          />

          {/* Run Validation button */}
          <div className="pt-4 border-t space-y-3">
            {!canExecute ? (
              <div>
                <button
                  disabled
                  className="px-4 py-2 text-sm rounded-lg bg-muted text-muted-foreground cursor-not-allowed inline-flex items-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                  </svg>
                  Run Validation
                </button>
                <p className="text-sm text-muted-foreground mt-2">
                  Post-migration validation requires a Pro license. Upgrade at betterdb.com/pricing
                </p>
              </div>
            ) : (
              <button
                onClick={handleStartValidation}
                className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Run Validation &rarr;
              </button>
            )}
          </div>

          <button
            onClick={() => {
              setPhase('idle');
              setJob(null);
              setAnalysisId(null);
              setExecutionId(null);
              setValidationId(null);
              setExecutionResult(null);
            }}
            className="mt-4 px-4 py-2 text-sm border rounded-lg hover:bg-muted"
          >
            Run another analysis
          </button>
        </>
      )}

      {phase === 'validating' && job && validationId && (
        <>
          <MigrationReport job={job} />
          {executionId && (
            <ExecutionPanel
              executionId={executionId}
              onStopped={() => {/* already stopped */}}
            />
          )}
          <ValidationPanel
            validationId={validationId}
            onComplete={() => setPhase('validated')}
          />
        </>
      )}

      {phase === 'validated' && job && validationId && (
        <>
          <ExportBar job={job} phase={phase} />
          <MigrationReport job={job} />
          {executionId && (
            <ExecutionPanel
              executionId={executionId}
              onStopped={() => {/* already stopped */}}
            />
          )}
          <ValidationPanel
            validationId={validationId}
          />
          <button
            onClick={() => {
              setPhase('idle');
              setJob(null);
              setAnalysisId(null);
              setExecutionId(null);
              setValidationId(null);
              setExecutionResult(null);
            }}
            className="mt-4 px-4 py-2 text-sm border rounded-lg hover:bg-muted"
          >
            Run another analysis
          </button>
        </>
      )}
    </div>
  );
}
