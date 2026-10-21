import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const DEFAULT_CLIENT_ANALYTICS_QUERY_BUDGET_MS = 2000;
const WARNING_SUPPRESS_MS = 5 * 60_000;

export function readPositiveNumber(
  configService: ConfigService | undefined,
  key: string,
  fallback: number,
): number {
  const raw = configService?.get<number | string>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Times storage calls against a budget. A call that runs over logs one
 * warning per call name, then stays quiet for that name for five minutes so a
 * consistently slow query cannot flood the log. Never changes the outcome of
 * the call it wraps.
 */
export class QueryBudget {
  private readonly lastWarnedAt = new Map<string, number>();

  constructor(
    readonly budgetMs: number,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  static fromConfig(configService: ConfigService | undefined, logger: Logger): QueryBudget {
    return new QueryBudget(
      readPositiveNumber(configService, 'CLIENT_ANALYTICS_QUERY_BUDGET_MS', DEFAULT_CLIENT_ANALYTICS_QUERY_BUDGET_MS),
      logger,
    );
  }

  async time<T>(name: string, connectionId: string | undefined, fn: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await fn();
    } finally {
      const elapsed = this.now() - started;
      if (elapsed > this.budgetMs) {
        this.warn(name, connectionId, elapsed);
      }
    }
  }

  private warn(name: string, connectionId: string | undefined, elapsedMs: number): void {
    const now = this.now();
    const last = this.lastWarnedAt.get(name);
    if (last !== undefined && now - last < WARNING_SUPPRESS_MS) {
      return;
    }
    this.lastWarnedAt.set(name, now);
    this.logger.warn(
      `Storage call ${name} for connection ${connectionId ?? 'all'} took ${Math.round(elapsedMs)}ms ` +
        `(budget ${this.budgetMs}ms); further warnings for ${name} suppressed for 5 minutes`,
    );
  }
}
