export const ACTIVITY_CONFIG = 'ACTIVITY_CONFIG';
export const DEFAULT_RETENTION_DAYS = 90;

export interface ActivityConfig {
  retentionDays: number;
}

export function parseActivityRetentionDays(raw: string | undefined): number | null {
  const value = raw?.trim() ?? '';
  if (/^\d+$/.test(value) === false) {
    return null;
  }
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) === false || parsed < 1) {
    return null;
  }
  return parsed;
}

export function resolveActivityConfig(env: NodeJS.ProcessEnv): ActivityConfig {
  return {
    retentionDays:
      parseActivityRetentionDays(env.ACTIVITY_RETENTION_DAYS) ?? DEFAULT_RETENTION_DAYS,
  };
}
