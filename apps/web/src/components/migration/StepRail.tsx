import { Button } from '../ui/button';

interface Props {
  currentStep: number;
  onBack?: () => void;
}

const STEPS = ['Configure', 'Analyse', 'Migrate'] as const;

export function StepRail({ currentStep, onBack }: Props) {
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-3" aria-label="Migration progress">
      {onBack !== undefined && (
        <Button variant="outline" size="sm" onClick={onBack} className="mr-2">
          ← Change configuration
        </Button>
      )}

      {STEPS.map((label, index) => {
        const isCurrent = index === currentStep;
        const isDone = index < currentStep;

        return (
          <span key={label} className="flex items-center gap-3">
            {index > 0 && <span aria-hidden="true" className="h-px w-10 bg-border" />}
            <span
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex items-center gap-2 text-sm ${
                isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground'
              }`}
            >
              <span
                className={`grid size-6 place-items-center rounded-full border text-xs font-semibold ${
                  isCurrent || isDone
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border'
                }`}
              >
                {index + 1}
              </span>
              {label}
            </span>
          </span>
        );
      })}
    </nav>
  );
}
