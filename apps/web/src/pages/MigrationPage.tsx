import { useState, useRef, useEffect } from 'react';
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

// ── Helpers ──

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function stepIndex(phase: Phase): number {
  if (phase === 'idle') return 0;
  if (phase === 'analyzing' || phase === 'analyzed') return 1;
  return 2;
}

// ── Small shared components ──

function LockIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
      <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
    </svg>
  );
}

const STEPS = ['Configure', 'Analyse', 'Migrate'] as const;

function StepIndicator({ phase, onBack }: { phase: Phase; onBack?: () => void }) {
  const current = stepIndex(phase);
  return (
    <nav className="flex items-center gap-2 text-sm mb-2">
      {onBack && (
        <button
          onClick={onBack}
          className="px-3 py-1 text-sm border rounded-md hover:bg-muted mr-2"
        >
          &larr; Change configuration
        </button>
      )}
      {STEPS.map((label, i) => (
        <span key={label} className="flex items-center gap-2">
          {i > 0 && <span className="text-muted-foreground">&rarr;</span>}
          <span
            className={
              i === current
                ? 'font-semibold text-primary'
                : i < current
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/50'
            }
          >
            {i + 1}. {label}
          </span>
        </span>
      ))}
    </nav>
  );
}

// ── Main page ──

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

  // Issue 1 + 4: confirmation dialog state
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [migrationStarting, setMigrationStarting] = useState(false);

  // Scroll target for validation section
  const validationRef = useRef<HTMLDivElement>(null);

  // Issue 15: history
  const [history, setHistory] = useState<MigrationAnalysisResult[]>([]);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);

  // Scroll to validation section when it appears
  useEffect(() => {
    if (phase === 'validating') {
      validationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [phase]);

  // General cleanup: centralized reset
  const resetToIdle = (saveToHistory = true) => {
    if (saveToHistory && job) {
      setHistory(prev => [job, ...prev].slice(0, 5));
    }
    setPhase('idle');
    setJob(null);
    setAnalysisId(null);
    setExecutionId(null);
    setValidationId(null);
    setExecutionResult(null);
  };

  // Issue 1: open dialog instead of window.confirm
  const handleStartMigration = () => {
    if (!job?.sourceConnectionId || !job?.targetConnectionId) return;
    setShowConfirmDialog(true);
  };

  // Issue 4: actual API call after user confirms
  const handleConfirmMigration = async () => {
    if (!job?.sourceConnectionId || !job?.targetConnectionId) return;
    setMigrationStarting(true);
    try {
      const result = await fetchApi<{ id: string }>('/migration/execution', {
        method: 'POST',
        body: JSON.stringify({
          sourceConnectionId: job.sourceConnectionId,
          targetConnectionId: job.targetConnectionId,
          mode: executionMode,
        }),
      });
      setShowConfirmDialog(false);
      setExecutionId(result.id);
      setPhase('executing');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setShowConfirmDialog(false);
    } finally {
      setMigrationStarting(false);
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
        <h1 className="text-2xl font-bold">Migration</h1>
        <p className="text-muted-foreground mt-1">
          Analyze your source instance to assess migration readiness.
        </p>
      </div>

      {/* Issue 3: Step indicator */}
      <StepIndicator
        phase={phase}
        onBack={phase !== 'idle' && phase !== 'analyzing' ? () => resetToIdle() : undefined}
      />

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

            {/* Issue 8: prominent blocking warning */}
            {blockingCount > 0 && (
              <div className="bg-red-50 border border-red-300 text-red-700 rounded-lg p-4 flex items-start gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 mt-0.5 flex-shrink-0">
                  <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.499-2.599 4.499H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.004zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clipRule="evenodd" />
                </svg>
                <div>
                  <p className="font-medium">{blockingCount} blocking issue{blockingCount !== 1 ? 's' : ''} detected</p>
                  <p className="text-sm mt-1">Proceeding may cause data loss or incompatibility on the target instance.</p>
                </div>
              </div>
            )}

            {!canExecute && (
              <p className="text-sm text-muted-foreground">
                Migration execution requires a Pro license. Upgrade at betterdb.com/pricing
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {!canExecute ? (
                <button
                  disabled
                  className="px-4 py-2 text-sm rounded-lg bg-muted text-muted-foreground cursor-not-allowed inline-flex items-center gap-2"
                >
                  <LockIcon />
                  Start Migration
                </button>
              ) : (
                <button
                  onClick={handleStartMigration}
                  className={blockingCount > 0
                    ? 'px-4 py-2 text-sm rounded-lg border border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100'
                    : 'px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90'
                  }
                >
                  Start Migration &rarr;
                </button>
              )}
              <ExportBar job={job} phase={phase} />
              <button
                onClick={() => resetToIdle()}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-muted"
              >
                Run another analysis
              </button>
            </div>
          </div>
        </>
      )}

      {phase === 'executing' && job && executionId && (
        <>
          <MigrationReport job={job} />
          <ExecutionPanel
            executionId={executionId}
            onStopped={async () => {
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
          <MigrationReport job={job} />
          <ExecutionPanel
            executionId={executionId}
            onStopped={() => {/* already stopped */}}
          />

          {/* Run Validation + actions */}
          <div className="pt-4 border-t space-y-3">
            {!canExecute && (
              <p className="text-sm text-muted-foreground">
                Post-migration validation requires a Pro license. Upgrade at betterdb.com/pricing
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {!canExecute ? (
                <button
                  disabled
                  className="px-4 py-2 text-sm rounded-lg bg-muted text-muted-foreground cursor-not-allowed inline-flex items-center gap-2"
                >
                  <LockIcon />
                  Run Validation
                </button>
              ) : (
                <button
                  onClick={handleStartValidation}
                  className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  Run Validation &rarr;
                </button>
              )}
              <ExportBar job={job} phase={phase} />
              <button
                onClick={() => resetToIdle()}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-muted"
              >
                Run another analysis
              </button>
            </div>
          </div>
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
          <div ref={validationRef}>
            <ValidationPanel
              validationId={validationId}
              onComplete={() => setPhase('validated')}
            />
          </div>
        </>
      )}

      {phase === 'validated' && job && validationId && (
        <>
          <MigrationReport job={job} />
          {executionId && (
            <ExecutionPanel
              executionId={executionId}
              onStopped={() => {/* already stopped */}}
            />
          )}
          <div ref={validationRef}>
            <ValidationPanel
              validationId={validationId}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ExportBar job={job} phase={phase} />
            <button
              onClick={() => resetToIdle()}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-muted"
            >
              Run another analysis
            </button>
          </div>
        </>
      )}

      {/* Issue 4: Confirmation dialog */}
      {showConfirmDialog && job && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => { if (!migrationStarting) setShowConfirmDialog(false); }}
        >
          <div
            className="bg-card border rounded-xl shadow-lg p-6 max-w-md w-full mx-4 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Confirm Migration</h2>
            <dl className="text-sm space-y-2">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Source</dt>
                <dd className="font-medium">{job.sourceConnectionName ?? 'Unknown'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Target</dt>
                <dd className="font-medium">{job.targetConnectionName ?? 'Unknown'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Total keys</dt>
                <dd className="font-medium">{(job.totalKeys ?? 0).toLocaleString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Estimated memory</dt>
                <dd className="font-medium">{formatBytes(job.estimatedTotalMemoryBytes ?? job.totalMemoryBytes ?? 0)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Mode</dt>
                <dd className="font-medium">{executionMode === 'command' ? 'Command-based' : 'DUMP/RESTORE (RedisShake)'}</dd>
              </div>
            </dl>

            {blockingCount > 0 && (
              <div className="bg-red-50 border border-red-300 text-red-700 rounded-lg p-3 text-sm">
                <strong>Warning:</strong> {blockingCount} blocking issue{blockingCount !== 1 ? 's' : ''} detected.
                Proceeding may cause data loss or incompatibility.
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowConfirmDialog(false)}
                disabled={migrationStarting}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmMigration}
                disabled={migrationStarting}
                className={`px-4 py-2 text-sm rounded-lg inline-flex items-center gap-2 disabled:opacity-70 ${
                  blockingCount > 0
                    ? 'border border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                }`}
              >
                {migrationStarting && (
                  <span className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                )}
                Yes, start migration
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Issue 15: Past analyses history */}
      {history.length > 0 && (
        <div className="border-t pt-6 space-y-3">
          <h2 className="text-lg font-semibold">Past Analyses</h2>
          <div className="space-y-2">
            {history.map(entry => (
              <div key={entry.id} className="border rounded-lg">
                <button
                  onClick={() => setExpandedHistoryId(prev => prev === entry.id ? null : entry.id)}
                  className="w-full text-left px-4 py-3 text-sm flex items-center justify-between hover:bg-muted/50 rounded-lg"
                >
                  <span>
                    {entry.sourceConnectionName ?? 'Source'} &rarr; {entry.targetConnectionName ?? 'Target'}
                    <span className="text-muted-foreground ml-2">
                      &middot; {(entry.totalKeys ?? 0).toLocaleString()} keys
                      {(entry.blockingCount ?? 0) > 0 && (
                        <span className="text-red-600 ml-1">&middot; {entry.blockingCount} blocking</span>
                      )}
                    </span>
                  </span>
                  <span className="text-muted-foreground">{expandedHistoryId === entry.id ? '\u25B2' : '\u25BC'}</span>
                </button>
                {expandedHistoryId === entry.id && (
                  <div className="px-4 pb-4">
                    <MigrationReport job={entry} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
