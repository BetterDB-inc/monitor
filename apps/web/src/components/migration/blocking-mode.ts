import { blocksMode, type ExecutionMode, type Incompatibility } from '@betterdb/shared';

/** Labels for the execution modes; a Record so tsc flags a mode added to ExecutionMode. */
export const EXECUTION_MODE_LABELS: Record<ExecutionMode, string> = {
  command: 'Command mode',
  redis_shake: 'DUMP/RESTORE (RedisShake)',
  redis_shake_sync: 'Online sync (RedisShake PSYNC)',
};

const ALL_MODES = Object.keys(EXECUTION_MODE_LABELS) as ExecutionMode[];

/** Blockers that stop `mode`, by the same rule as the API safety gate. Without a mode, every blocker. */
export function blockingCountForMode(
  result: { incompatibilities?: Incompatibility[]; blockingCount?: number },
  mode?: ExecutionMode,
): number {
  // Old stored verdicts have no incompatibilities; their total is all there is.
  if (!result.incompatibilities) return result.blockingCount ?? 0;
  return result.incompatibilities.filter((i) => blocksMode(i, mode)).length;
}

/** Modes no blocker applies to, when some blockers are scoped to other modes. Empty when none is scoped. */
export function modesWithoutBlockers(issues: Incompatibility[] | undefined): ExecutionMode[] {
  const blockers = (issues ?? []).filter((i) => blocksMode(i));
  if (blockers.length === 0 || blockers.every((i) => !i.modes)) return [];
  return ALL_MODES.filter((m) => !blockers.some((i) => blocksMode(i, m)));
}

/** Blockers that stop `mode`, by the same rule as the API safety gate. */
export function blockingIssuesForMode(
  issues: Incompatibility[] | undefined,
  mode?: ExecutionMode,
): Incompatibility[] {
  return (issues ?? []).filter((i) => blocksMode(i, mode));
}

/**
 * Mirrors the server's forceReason rule (migration-execution.service.ts): it must be
 * non-empty after trimming, and only the first 500 characters are logged. Keep in sync.
 */
export const FORCE_REASON_MIN_LENGTH = 1;
export const FORCE_REASON_MAX_LENGTH = 500;

export interface StartExecutionInput {
  sourceConnectionId: string;
  targetConnectionId: string;
  mode: ExecutionMode;
  /** Blockers that apply to `mode` (blockingIssuesForMode). */
  blockers: Incompatibility[];
  forceReason?: string;
  /** Other request fields (sync reader and RedisShake options), passed through unchanged. */
  extra?: Record<string, unknown>;
}

/**
 * Request body for starting a migration. Sends force + forceReason only when
 * the selected mode has blockers, so an unblocked start is what it was before.
 */
export function buildStartExecutionBody(input: StartExecutionInput) {
  const base = {
    sourceConnectionId: input.sourceConnectionId,
    targetConnectionId: input.targetConnectionId,
    mode: input.mode,
    ...input.extra,
  };
  if (input.blockers.length === 0) return base;
  return { ...base, force: true as const, forceReason: (input.forceReason ?? '').trim() };
}

/** Whether the typed reason satisfies the server rule. */
export function isForceReasonValid(reason: string | undefined): boolean {
  return (reason ?? '').trim().length >= FORCE_REASON_MIN_LENGTH;
}
