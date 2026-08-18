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
  return (
    <div className="border-t pt-5">
      <div className="grid gap-2 sm:grid-cols-3">
        {STEPS.map((step, index) => {
          const isCurrent = index === currentStep;
          const isDone = index < currentStep;

          return (
            <div
              key={step.title}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex items-start gap-3 rounded-lg p-3 transition-colors ${
                isCurrent ? 'bg-muted/60' : ''
              }`}
            >
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
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{step.body}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
