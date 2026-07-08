import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { MAX_BATCH_PAUSE_MS, MAX_COUNT } from '../bulk-delete-engine';

/** Shared fields for preview (dry-run) and execute. */
export class BulkDeletePreviewDto {
  /** Glob pattern passed to SCAN MATCH (e.g. "session:*"). Required. */
  @IsString()
  @IsNotEmpty()
  match!: string;

  /** Optional SCAN TYPE filter (e.g. "string", "hash", "list"). */
  @IsOptional()
  @IsString()
  type?: string;

  /** SCAN COUNT hint per batch. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_COUNT)
  count?: number;

  /** Walk only the connected node, or fan out across every cluster primary. */
  @IsOptional()
  @IsIn(['node', 'cluster'])
  scope?: 'node' | 'cluster';

  /** Hard cap on keys acted upon; omit for the default (preview cap / unbounded execute). */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxKeys?: number;

  /** Required to allow a catch-all pattern (e.g. "*"). */
  @IsOptional()
  @IsBoolean()
  confirmDeleteAll?: boolean;
}

export class BulkDeleteExecuteDto extends BulkDeletePreviewDto {
  /** Pause between batches to bound latency impact (ms). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BATCH_PAUSE_MS)
  batchPauseMs?: number;
}
