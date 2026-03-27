import type { ValidationJobStatus, MigrationValidationResult } from '@betterdb/shared';

export interface ValidationJob {
  id: string;
  status: ValidationJobStatus;
  progress: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
  result: Partial<MigrationValidationResult>;
  cancelled: boolean;
}
