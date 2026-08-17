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

export function HowItWorks() {
  return (
    <div className="border-t pt-5">
      <div className="grid gap-5 sm:grid-cols-3">
        {STEPS.map((step, index) => {
          return (
            <div key={step.title} className="flex items-start gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold text-muted-foreground">
                {index + 1}
              </span>
              <div>
                <p className="text-sm font-semibold">{step.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{step.body}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
