import { z } from 'zod';
import {
  DEFAULT_PLACEMENT_SETTINGS,
  defaultPlacementSettings,
  type PlacementPolicyInvalid,
  type PlacementSettings,
} from '../types/placement.types';

const CLUSTER_SLOTS = 16384;
const MINUTES_PER_DAY = 24 * 60;

const share = z.number().gt(0).lte(1);

export const placementMaintenanceWindowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM in UTC'),
  durationMinutes: z.number().int().min(1).max(MINUTES_PER_DAY),
});

const placementSettingsFields = z.object({
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
});

export const placementSettingsSchema = placementSettingsFields.superRefine((settings, context) => {
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

function messagesOf(issues: readonly z.core.$ZodIssue[], prefix: string[] = []): string[] {
  return issues.map((issue) => {
    const path = [...prefix, ...issue.path.map(String)];
    return path.length > 0 ? `${path.join('.')}: ${issue.message}` : issue.message;
  });
}

export function validatePlacementSettings(input: unknown): PlacementSettingsResult {
  const parsed = placementSettingsSchema.safeParse(input);
  if (parsed.success) return { ok: true, settings: parsed.data };
  return { ok: false, errors: messagesOf(parsed.error.issues) };
}

export interface StoredPlacementSettings {
  settings: PlacementSettings;
  invalid: PlacementPolicyInvalid | null;
}

const EXCLUSION_FIELDS: readonly string[] = ['excludedShardIds', 'excludedSlots'];

function unreadable(problem: string): StoredPlacementSettings {
  return {
    settings: defaultPlacementSettings(),
    invalid: { problems: [problem], exclusionsReadable: false },
  };
}

export function readStoredPlacementSettings(stored: unknown): StoredPlacementSettings {
  if (stored === null || stored === undefined) {
    return { settings: defaultPlacementSettings(), invalid: null };
  }
  let document: unknown = stored;
  if (typeof stored === 'string') {
    try {
      document = JSON.parse(stored);
    } catch {
      return unreadable('the stored policy is not JSON');
    }
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return unreadable('the stored policy is not an object');
  }
  const fields = document as Record<string, unknown>;
  const settings = defaultPlacementSettings() as unknown as Record<string, unknown>;
  const problems: string[] = [];
  let exclusionsReadable = true;
  for (const [field, schema] of Object.entries(placementSettingsFields.shape)) {
    if (!(field in fields)) continue;
    const parsed = schema.safeParse(fields[field]);
    if (parsed.success) {
      settings[field] = parsed.data;
      continue;
    }
    problems.push(...messagesOf(parsed.error.issues, [field]));
    if (EXCLUSION_FIELDS.includes(field)) exclusionsReadable = false;
  }
  const checked = validatePlacementSettings(settings);
  if (!checked.ok) {
    problems.push(...checked.errors);
    settings.triggerRatio = DEFAULT_PLACEMENT_SETTINGS.triggerRatio;
    settings.resolveRatio = DEFAULT_PLACEMENT_SETTINGS.resolveRatio;
  }
  return {
    settings: settings as unknown as PlacementSettings,
    invalid: problems.length > 0 ? { problems, exclusionsReadable } : null,
  };
}

export function excludedPrimaryIds(
  excludedNodeIds: readonly string[],
  nodes: ReadonlyArray<{ id: string; master: string }>,
): string[] {
  const excluded = new Set(excludedNodeIds);
  for (const node of nodes) {
    if (!excludedNodeIds.includes(node.id)) continue;
    const primary = node.master && node.master !== '-' ? node.master : node.id;
    excluded.add(primary);
  }
  return [...excluded];
}
