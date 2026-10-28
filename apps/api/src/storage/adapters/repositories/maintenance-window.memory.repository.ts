import { maintenanceWindowEffectiveEnd, type MaintenanceWindow } from '@betterdb/shared';
import type { MaintenanceWindowRepository } from '../../../common/interfaces/maintenance-window-repository.interface';

function copy(window: MaintenanceWindow): MaintenanceWindow {
  return { ...window, events: [...window.events] };
}

export class MaintenanceWindowMemoryRepository implements MaintenanceWindowRepository {
  private readonly windows = new Map<string, MaintenanceWindow>();

  clear(): void {
    this.windows.clear();
  }

  async list(): Promise<MaintenanceWindow[]> {
    return Array.from(this.windows.values())
      .sort((a, b) => b.startsAt - a.startsAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0))
      .map(copy);
  }

  async get(id: string): Promise<MaintenanceWindow | null> {
    const window = this.windows.get(id);
    return window === undefined ? null : copy(window);
  }

  async save(window: MaintenanceWindow): Promise<void> {
    this.windows.set(window.id, copy(window));
  }

  async delete(id: string): Promise<boolean> {
    return this.windows.delete(id);
  }

  async prune(endedBefore: number): Promise<number> {
    let pruned = 0;
    for (const [id, window] of this.windows) {
      if (maintenanceWindowEffectiveEnd(window) < endedBefore) {
        this.windows.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}
