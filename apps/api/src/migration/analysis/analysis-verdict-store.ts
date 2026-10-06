import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Incompatibility } from '@betterdb/shared';

/** File-backed gate verdicts so the gate survives restart/eviction. Best-effort; local to this replica. */

export interface AnalysisVerdict {
  analysisId: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  completedAt: number;
  createdAt: number;
  incompatibilities: Incompatibility[];
  blockingCount: number;
  warningCount: number;
}

export function resolveVerdictDir(customDir?: string): string {
  if (customDir) return customDir;
  const envDir = process.env.MIGRATION_VERDICT_DIR;
  if (envDir && envDir.length > 0) return envDir;
  return join(process.cwd(), 'data', 'migration-analysis-verdicts');
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128);
}

export function verdictFilePath(dir: string, sourceId: string, targetId: string): string {
  return join(dir, `${sanitizeId(sourceId)}__${sanitizeId(targetId)}.json`);
}

export function saveAnalysisVerdict(dir: string, verdict: AnalysisVerdict): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = verdictFilePath(dir, verdict.sourceConnectionId, verdict.targetConnectionId);
    try {
      const existing = loadAnalysisVerdict(dir, verdict.sourceConnectionId, verdict.targetConnectionId);
      if (existing && existing.completedAt >= verdict.completedAt) return;
    } catch { /* ignore read errors */ }
    writeFileSync(path, JSON.stringify(verdict), { encoding: 'utf-8', mode: 0o600 });
  } catch { /* best-effort */ }
}

export function loadAnalysisVerdict(
  dir: string,
  sourceId: string,
  targetId: string,
): AnalysisVerdict | undefined {
  try {
    const path = verdictFilePath(dir, sourceId, targetId);
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AnalysisVerdict>;
    if (!parsed || typeof parsed.analysisId !== 'string') return undefined;
    if (typeof parsed.completedAt !== 'number') return undefined;
    if (parsed.sourceConnectionId !== sourceId || parsed.targetConnectionId !== targetId) {
      return undefined;
    }
    return {
      analysisId: parsed.analysisId,
      sourceConnectionId: parsed.sourceConnectionId,
      targetConnectionId: parsed.targetConnectionId,
      completedAt: parsed.completedAt,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : parsed.completedAt,
      incompatibilities: Array.isArray(parsed.incompatibilities) ? parsed.incompatibilities : [],
      blockingCount: typeof parsed.blockingCount === 'number' ? parsed.blockingCount : 0,
      warningCount: typeof parsed.warningCount === 'number' ? parsed.warningCount : 0,
    };
  } catch {
    return undefined;
  }
}
