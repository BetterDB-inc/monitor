import type { AsyncLocalStorage } from 'async_hooks';

export interface Pass {
  name: string;
  startedAt: number;
  commands: number;
  polls: number;
}

export interface PassTotals {
  durations: number[];
  commands: number;
}

export class PassRecorder {
  private readonly finished = new Map<string, Array<{ pass: Pass; durationMs: number }>>();
  private windowStartedAt = 0;

  track(name: string): void {
    this.finished.set(name, []);
  }

  startWindow(now: number): void {
    this.windowStartedAt = now;
    for (const passes of this.finished.values()) passes.length = 0;
  }

  begin(name: string, now: number): Pass {
    return { name, startedAt: now, commands: 0, polls: 0 };
  }

  end(pass: Pass, now: number): void {
    if (pass.startedAt < this.windowStartedAt || pass.polls === 0) return;
    this.finished.get(pass.name)?.push({ pass, durationMs: now - pass.startedAt });
  }

  totals(): Map<string, PassTotals> {
    return new Map(
      [...this.finished].map(([name, passes]) => [
        name,
        {
          durations: passes.map(({ durationMs }) => durationMs),
          commands: passes.reduce((sum, { pass }) => sum + pass.commands, 0),
        },
      ]),
    );
  }
}

export function recordPasses(
  tick: () => Promise<void>,
  isBusy: () => boolean,
  name: string,
  passes: PassRecorder,
  context: AsyncLocalStorage<Pass>,
): () => Promise<void> {
  passes.track(name);
  return () => {
    if (isBusy()) return tick();
    const pass = passes.begin(name, performance.now());
    return context.run(pass, async () => {
      try {
        await tick();
      } finally {
        passes.end(pass, performance.now());
      }
    });
  };
}

export function countPolls<Args extends unknown[], Result>(
  poll: (...args: Args) => Result,
  context: AsyncLocalStorage<Pass>,
): (...args: Args) => Result {
  return (...args) => {
    const pass = context.getStore();
    if (pass) pass.polls += 1;
    return poll(...args);
  };
}
