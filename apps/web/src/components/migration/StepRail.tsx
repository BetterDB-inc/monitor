import { Fragment } from 'react';
import { Button } from '../ui/button';

interface Props {
  currentStep: number;
  onBack?: () => void;
}

const STEPS = ['Configure', 'Analyse', 'Migrate'] as const;

export function StepRail({ currentStep, onBack }: Props) {
  return (
    <nav className="mb-6 flex w-full items-center gap-5" aria-label="Migration progress">
      {onBack !== undefined && (
        <Button variant="outline" size="sm" onClick={onBack} className="mr-2 shrink-0">
          ← Change configuration
        </Button>
      )}

      {STEPS.map((label, index) => {
        const isCurrent = index === currentStep;
        const isDone = index < currentStep;

        return (
          <Fragment key={label}>
            {index > 0 && <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border" />}
            <span
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex shrink-0 items-center gap-3 text-xl ${
                isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground'
              }`}
            >
              <span
                className={`grid size-12 place-items-center rounded-full border text-xl font-semibold ${
                  isCurrent || isDone
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border'
                }`}
              >
                {index + 1}
              </span>
              {label}
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}
