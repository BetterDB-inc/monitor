import { useState, useEffect, useRef } from 'react';
import { fetchApi } from '../../api/client';
import type { MigrationAnalysisResult } from '@betterdb/shared';

interface Props {
  analysisId: string;
  onComplete: (result: MigrationAnalysisResult) => void;
  onError: (msg: string) => void;
  onCancel: () => void;
}

function getStepLabel(progress: number): string {
  if (progress <= 12) return 'Connecting and reading server info';
  if (progress <= 14) return 'Detecting cluster topology';
  if (progress <= 50) return 'Scanning keyspace';
  if (progress <= 65) return 'Sampling memory usage';
  if (progress <= 75) return 'Analyzing TTL distribution';
  if (progress <= 85) return 'Checking Hash Field Expiry';
  if (progress <= 95) return 'Analyzing command patterns';
  return 'Computing migration verdict';
}

export function AnalysisProgressBar({ analysisId, onComplete, onError, onCancel }: Props) {
  const [job, setJob] = useState<MigrationAnalysisResult | null>(null);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  const onCancelRef = useRef(onCancel);
  onCompleteRef.current = onComplete;
  onErrorRef.current = onError;
  onCancelRef.current = onCancel;

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const result = await fetchApi<MigrationAnalysisResult>(`/migration/analysis/${analysisId}`);
        setJob(result);
        if (result.status === 'completed') {
          clearInterval(interval);
          onCompleteRef.current(result);
        } else if (result.status === 'failed') {
          clearInterval(interval);
          onErrorRef.current(result.error ?? 'Analysis failed');
        } else if (result.status === 'cancelled') {
          clearInterval(interval);
          onCancelRef.current();
        }
      } catch {
        clearInterval(interval);
        onErrorRef.current('Analysis job not found or server error');
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [analysisId]);

  const handleCancel = async () => {
    try {
      await fetchApi(`/migration/analysis/${analysisId}`, { method: 'DELETE' });
    } catch {
      /* ignore */
    }
    onCancel();
  };

  const currentProgress = job?.progress ?? 0;

  return (
    <div className="bg-card border rounded-lg p-6 space-y-4 max-w-lg">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Analyzing...</span>
        <span className="text-sm text-muted-foreground">{currentProgress}%</span>
      </div>
      <div className="w-full bg-muted rounded-full h-2">
        <div
          className="bg-primary h-2 rounded-full transition-all duration-500"
          style={{ width: `${currentProgress}%` }}
        />
      </div>
      <p className="text-sm text-muted-foreground">{getStepLabel(currentProgress)}</p>
      <button
        onClick={handleCancel}
        className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted"
      >
        Cancel
      </button>
    </div>
  );
}
