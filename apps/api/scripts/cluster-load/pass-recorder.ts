export interface Pass {
  name: string;
  startedAt: number;
  commands: number;
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
    return { name, startedAt: now, commands: 0 };
  }

  end(pass: Pass, now: number): void {
    if (pass.startedAt < this.windowStartedAt) return;
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
