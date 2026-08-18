import { StepIllustration } from './how-it-works/StepIllustration';

interface Props {
  currentStep: number;
}

const STEPS = [
  {
    title: 'Configure',
    body: 'Pick the instance to copy from and the one to copy to. They must be different, and the target has to accept writes.',
  },
  {
    title: 'Analyse',
    body: 'We sample keys with SCAN and report size, data types, TTLs and anything the target handles differently. Nothing is modified.',
  },
  {
    title: 'Migrate',
    body: 'Review the findings, then run the copy. You approve every migration before a single key moves.',
  },
] as const;

export function HowItWorks({ currentStep }: Props) {
  const expanded = currentStep === 0;

  return (
    <div className="border-t pt-6">
      <ol className={expanded ? 'grid gap-4 sm:grid-cols-3' : 'grid gap-2 sm:grid-cols-3'}>
        {STEPS.map((step, index) => {
          const isCurrent = index === currentStep;
          const isDone = index < currentStep;

          let cardClass: string;
          if (expanded) {
            cardClass = isCurrent
              ? 'flex min-h-[17rem] flex-col gap-5 rounded-xl border border-primary/30 bg-muted/40 p-5'
              : 'flex min-h-[17rem] flex-col gap-5 rounded-xl border bg-card p-5';
          } else {
            cardClass = isCurrent ? 'rounded-lg bg-muted/60 p-3' : 'rounded-lg p-3';
          }

          return (
            <li
              key={step.title}
              aria-current={isCurrent ? 'step' : undefined}
              className={cardClass}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold ${
                    isCurrent || isDone
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground'
                  }`}
                >
                  {index + 1}
                </span>
                <div>
                  <p
                    className={`text-sm font-semibold ${
                      isCurrent ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {step.title}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              </div>

              {expanded && (
                <div className="grid flex-1 place-items-center px-2 py-4">
                  <StepIllustration step={index} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
