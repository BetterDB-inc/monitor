import { useState } from 'react';
import type { MigrationAnalysisResult } from '@betterdb/shared';
import { AnalysisForm } from '../components/migration/AnalysisForm';
import { AnalysisProgressBar } from '../components/migration/AnalysisProgressBar';
import { MigrationReport } from '../components/migration/MigrationReport';
import { ExportBar } from '../components/migration/ExportBar';

type Phase = 'idle' | 'running' | 'done';

export function MigrationPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [job, setJob] = useState<MigrationAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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
            setPhase('running');
            setError(null);
          }}
        />
      )}

      {phase === 'running' && analysisId && (
        <AnalysisProgressBar
          analysisId={analysisId}
          onComplete={(result) => {
            setJob(result);
            setPhase('done');
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

      {phase === 'done' && job && (
        <>
          <ExportBar job={job} />
          <MigrationReport job={job} />
          <button
            onClick={() => {
              setPhase('idle');
              setJob(null);
              setAnalysisId(null);
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
