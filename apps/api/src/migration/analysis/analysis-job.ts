import type { MigrationJobStatus, MigrationAnalysisResult } from '@betterdb/shared';
import type Valkey from 'iovalkey';

export interface AnalysisJob {
  id: string;
  status: MigrationJobStatus;
  progress: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
  result: Partial<MigrationAnalysisResult>;
  cancelled: boolean;
  nodeClients: Valkey[];
}
