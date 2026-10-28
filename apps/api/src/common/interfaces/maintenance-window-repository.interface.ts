import type { MaintenanceWindow } from '@betterdb/shared';

export interface MaintenanceWindowRepository {
  /** Every stored window, newest start first. */
  list(): Promise<MaintenanceWindow[]>;
  get(id: string): Promise<MaintenanceWindow | null>;
  /** Insert or replace by id. */
  save(window: MaintenanceWindow): Promise<void>;
  delete(id: string): Promise<boolean>;
  /** Deletes windows that stopped silencing before `endedBefore` (epoch ms). */
  prune(endedBefore: number): Promise<number>;
}
