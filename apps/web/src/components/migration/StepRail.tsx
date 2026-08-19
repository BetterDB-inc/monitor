import { Fragment } from 'react';
import { MIGRATION_STEPS } from './analysis-form/migration-steps';

interface Props {
  currentStep: number;
}

export function StepRail({ currentStep }: Props) {
  return (
    <nav className="mb-6 flex w-full items-start gap-5" aria-label="Migration progress">
      {MIGRATION_STEPS.map((step, index) => {
        const isCurrent = index === currentStep;
        const isDone = index < currentStep;

        return (
          <Fragment key={step.title}>
            {index > 0 && (
              <span aria-hidden="true" className="mt-6 h-px min-w-4 flex-1 bg-border" />
            )}
            <span
              aria-current={isCurrent ? 'step' : undefined}
              className="flex min-w-0 shrink basis-0 flex-col items-center gap-2 text-center"
            >
              <span
                className={`grid size-12 shrink-0 place-items-center rounded-full border text-xl font-semibold ${
                  isCurrent || isDone
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground'
                }`}
              >
                {index + 1}
              </span>
              <span
                className={`text-base ${
                  isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground'
                }`}
              >
                {step.title}
              </span>
              <span className="hidden text-xs leading-relaxed text-muted-foreground sm:block">
                {step.body}
              </span>
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}
