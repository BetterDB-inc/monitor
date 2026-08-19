import { StepIllustration } from './how-it-works/StepIllustration';
import { MIGRATION_STEPS } from './migration-steps';

export function HowItWorks() {
  return (
    <div className="border-t pt-6">
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {MIGRATION_STEPS.map((step, index) => {
          return (
            <li
              key={step.title}
              className={`flex min-h-[17rem] flex-col gap-5 rounded-xl p-5 ${
                index === 0 ? 'border border-primary/30 bg-muted/40' : 'border bg-card'
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold ${
                    index === 0
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground'
                  }`}
                >
                  {index + 1}
                </span>
                <div>
                  <p
                    className={`text-sm font-semibold ${
                      index === 0 ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {step.title}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              </div>

              <div className="grid flex-1 place-items-center px-2 py-4">
                <StepIllustration step={index} />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
