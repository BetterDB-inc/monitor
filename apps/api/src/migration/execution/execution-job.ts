import type { ChildProcess } from 'child_process';
import type { ExecutionJobStatus, ExecutionMode } from '@betterdb/shared';

export interface ExecutionJob {
  id: string;
  mode: ExecutionMode;
  status: ExecutionJobStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  keysTransferred: number;
  bytesTransferred: number;
  keysSkipped: number;
  totalKeys: number;
  logs: string[];          // rolling, capped at MAX_LOG_LINES = 500
  progress: number | null;
  process: ChildProcess | null;   // redis_shake mode only
  tomlPath: string | null;        // redis_shake mode only
  pidPath: string | null;         // redis_shake mode only — for orphan detection
}
