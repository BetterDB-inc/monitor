export const ACTIVITY_CONFIG = 'ACTIVITY_CONFIG';
export const DEFAULT_RETENTION_DAYS = 90;

export interface ActivityConfig {
  retentionDays: number;
}

export function resolveActivityConfig(env: NodeJS.ProcessEnv): ActivityConfig {
  const raw = env.ACTIVITY_RETENTION_DAYS;
  if (raw === undefined || raw.trim().length === 0) {
    return { retentionDays: DEFAULT_RETENTION_DAYS };
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) === false || parsed < 1) {
    return { retentionDays: DEFAULT_RETENTION_DAYS };
  }
  return { retentionDays: parsed };
}
