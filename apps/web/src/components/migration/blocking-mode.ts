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
