import type { PhaseName, SimConfig } from '../config.js';
import type { ShardView } from './topology.js';

export interface Expected { patterns: string[]; metrics: string[]; nodes: string[] }

export interface ScenarioEvent {
  eventId: string;
  phase: string;
  action: 'start' | 'end' | 'note';
  ts: number;
  targetShard: number | null;
  targetPods: string[];
  params: Record<string, unknown>;
  expected: Expected;
}

export interface PhaseCtx {
  cfg: SimConfig;
  runId: string;
  runDir: string;
  topo(): Promise<Map<number, ShardView>>;
  note(message: string, data?: Record<string, unknown>): void;
  // Countdown banner; resolves early if the run is aborted.
  wait(sec: number, label: string): Promise<void>;
  aborted(): boolean;
}

// What inject() hands back: when the fault became effective and what we expect BetterDB to see.
export interface Injected {
  ts: number;
  targetShard: number | null;
  targetPods: string[];
  params: Record<string, unknown>;
  expected: Expected;
  // Opaque state revert() needs.
  state?: Record<string, unknown>;
}

export interface Phase {
  name: PhaseName;
  // Planned hold time (for DRY_RUN timeline); undefined = runs until its own completion check.
  plannedSec(cfg: SimConfig): number;
  summary(cfg: SimConfig): string;
  inject(ctx: PhaseCtx): Promise<Injected>;
  // Default: hold for plannedSec. Phases that end on a condition override this.
  hold?(ctx: PhaseCtx, injected: Injected): Promise<void>;
  // Must be idempotent and safe to call after a partial inject (SIGINT).
  revert(ctx: PhaseCtx, injected: Injected | undefined): Promise<void>;
}
