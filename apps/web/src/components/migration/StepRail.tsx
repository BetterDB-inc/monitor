import { Fragment } from 'react';
import { MIGRATION_STEPS } from './analysis-form/migration-steps';

interface Props {
  currentStep: number;
}

export function StepRail({ currentStep }: Props) {
  return (
    <nav className="mb-6 flex w-full items-start gap-4" aria-label="Migration progress">
      {MIGRATION_STEPS.map((step, index) => {
        const isCurrent = index === currentStep;
        const isDone = index < currentStep;

        return (
          <Fragment key={step.title}>
            {/* Connectors take all the slack so the rail spans the full width, with
                the first circle flush left and the last flush right. The steps stay
                shrink-0 — letting them absorb the slack instead is what squeezed the
                labels into one-word columns. `mt-6` is half of size-12, so the line
                meets the circles at their centre. */}
            {index > 0 && <span aria-hidden="true" className="mt-6 h-px flex-1 bg-border" />}
            <span
              aria-current={isCurrent ? 'step' : undefined}
              className="flex shrink-0 flex-col items-center gap-2"
            >
              <span
                className={`grid size-12 place-items-center rounded-full border text-xl font-semibold ${
                  isCurrent || isDone
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground'
                }`}
              >
                {index + 1}
              </span>
              <span
                className={`text-sm ${
                  isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground'
                }`}
              >
                {step.title}
              </span>
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}
