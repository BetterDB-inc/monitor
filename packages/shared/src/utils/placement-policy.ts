import { z } from 'zod';
import { DEFAULT_PLACEMENT_SETTINGS, type PlacementSettings } from '../types/placement.types';

const CLUSTER_SLOTS = 16384;
const MINUTES_PER_DAY = 24 * 60;

const share = z.number().gt(0).lte(1);

export const placementMaintenanceWindowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM in UTC'),
  durationMinutes: z.number().int().min(1).max(MINUTES_PER_DAY),
});

export const placementSettingsSchema = z
  .object({
    triggerRatio: z.number().gt(1).lte(100),
    maxCpuShare: share.nullable(),
    maxNetworkShare: share.nullable(),
    nodeCpuLimitUsecPerSecond: z.number().int().min(1),
    resolveRatio: z.number().gte(1),
    sustainMinutes: z.number().int().min(1).max(MINUTES_PER_DAY),
    slotCooldownDays: z.number().int().min(0).max(365),
    noReturnDays: z.number().int().min(0).max(365),
    maxMigrationsPerHour: z.number().int().min(0).max(60),
    maxBytesPerHour: z.number().int().min(0),
    maintenanceWindows: z.array(placementMaintenanceWindowSchema),
    excludedShardIds: z.array(z.string().min(1)),
    excludedSlots: z.array(
      z
        .number()
        .int()
        .min(0)
        .max(CLUSTER_SLOTS - 1),
    ),
    abortLatencyMs: z.number().int().min(1).max(60_000),
    verifyMinutes: z.number().int().min(1).max(MINUTES_PER_DAY),
    verifyTolerance: share,
    autoRollback: z.boolean(),
  })
  .superRefine((settings, context) => {
    if (settings.resolveRatio >= settings.triggerRatio) {
      context.addIssue({
        code: 'custom',
        path: ['resolveRatio'],
        message: 'must be below triggerRatio',
      });
    }
  });

export type PlacementSettingsResult =
  | { ok: true; settings: PlacementSettings }
  | { ok: false; errors: string[] };

export function validatePlacementSettings(input: unknown): PlacementSettingsResult {
  const parsed = placementSettingsSchema.safeParse(input);
  if (parsed.success) return { ok: true, settings: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    ),
  };
}

export function placementSettingsOf(stored: unknown): PlacementSettings {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return DEFAULT_PLACEMENT_SETTINGS;
  }
  const result = validatePlacementSettings({ ...DEFAULT_PLACEMENT_SETTINGS, ...stored });
  return result.ok ? result.settings : DEFAULT_PLACEMENT_SETTINGS;
}
