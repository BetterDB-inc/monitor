import { useState, useEffect, useRef } from 'react';
import { fetchApi } from '../../api/client';
import type { MigrationValidationResult } from '@betterdb/shared';
import { KeyCountSection } from './sections/KeyCountSection';
import { SampleValidationSection } from './sections/SampleValidationSection';
import { BaselineSection } from './sections/BaselineSection';

interface Props {
  validationId: string;
  onComplete?: () => void;
}

function getStepLabel(progress: number): string {
  if (progress <= 5) return 'Connecting...';
  if (progress <= 20) return 'Comparing key counts...';
  if (progress <= 70) return 'Validating sample keys...';
  if (progress <= 80) return 'Comparing baseline metrics...';
  if (progress <= 99) return 'Finalising...';
  return '';
}

export function ValidationPanel({ validationId, onComplete }: Props) {
  const [validation, setValidation] = useState<MigrationValidationResult | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    let stopped = false;
    let errorCount = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const result = await fetchApi<MigrationValidationResult>(`/migration/validation/${validationId}`);
        if (stopped) return;
        errorCount = 0;
        setValidation(result);
        if (result.status === 'completed' || result.status === 'failed') {
          onCompleteRef.current?.();
          return;
        }
      } catch {
        if (stopped) return;
        errorCount++;
      }
      if (!stopped) {
        const delay = errorCount > 0 ? Math.min(2000 * 2 ** errorCount, 30000) : 2000;
        timer = setTimeout(poll, delay);
      }
    };

    poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [validationId]);

  if (!validation) {
    return (
      <div className="bg-card border rounded-lg p-6">
        <p className="text-sm text-muted-foreground">Starting validation...</p>
      </div>
    );
  }

  const inProgress = validation.status === 'pending' || validation.status === 'running';
  const stepLabel = getStepLabel(validation.progress);

  return (
    <div className="space-y-4">
      {/* Progress bar — shown while in progress */}
      {inProgress && (
        <div className="bg-card border rounded-lg p-6 space-y-3 max-w-lg">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Validating...</span>
            <span className="text-sm text-muted-foreground">{validation.progress}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all duration-500"
              style={{ width: `${validation.progress}%` }}
            />
          </div>
          {stepLabel && <p className="text-sm text-muted-foreground">{stepLabel}</p>}
        </div>
      )}

      {/* Result banner */}
      {validation.status === 'completed' && validation.passed && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg p-4 text-sm">
          Validation passed — no issues found.
        </div>
      )}
      {validation.status === 'completed' && !validation.passed && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded-lg p-4 text-sm">
          Validation complete — {validation.issueCount ?? 0} issue{(validation.issueCount ?? 0) !== 1 ? 's' : ''} found.
        </div>
      )}
      {validation.status === 'failed' && (
        <div className="bg-destructive/5 border border-destructive/20 text-destructive rounded-lg p-4 text-sm">
          {validation.error ?? 'Validation failed'}
        </div>
      )}

      {/* Sections — rendered as they become available */}
      {validation.status !== 'pending' && (
        <div className="bg-card border rounded-lg p-6 space-y-6">
          {validation.keyCount !== undefined && (
            <KeyCountSection keyCount={validation.keyCount} />
          )}
          {validation.sampleValidation !== undefined && (
            <>
              <hr />
              <SampleValidationSection sample={validation.sampleValidation} />
            </>
          )}
          {validation.baseline !== undefined && (
            <>
              <hr />
              <BaselineSection baseline={validation.baseline} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
