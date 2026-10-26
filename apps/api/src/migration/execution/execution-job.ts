import type { ChildProcess } from 'child_process';
import type { ReplicationLagMap } from './replication-lag';
import type { ExecutionJobStatus, ExecutionMode, SyncStage, ExecutionFailureCode, CutoverAttempt } from '@betterdb/shared';

export interface ExecutionJob {
  id: string;
  mode: ExecutionMode;
  status: ExecutionJobStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  failureCode?: ExecutionFailureCode;   // set when status === 'failed' and classified
  keysTransferred: number;
  bytesTransferred: number;
  keysSkipped: number;
  totalKeys: number;
  logs: string[];          // rolling, capped at MAX_LOG_LINES = 500
  notices: string[];       // durable job-level notices, never evicted by the log cap
  progress: number | null;
  syncStage: SyncStage;
  replicationLag: ReplicationLagMap | null;
  expectedShards: number | null;
  cutover: CutoverAttempt | null;
  cutoverAt?: number;
  cutoverTimer: ReturnType<typeof setInterval> | null;
  cutoverStableSince: number | null;
  terminating: 'cancel' | 'cutover' | null;
  process: ChildProcess | null;   // redis_shake mode only
  tomlPath: string | null;        // redis_shake mode only
  pidPath: string | null;         // redis_shake mode only — for orphan detection
}
