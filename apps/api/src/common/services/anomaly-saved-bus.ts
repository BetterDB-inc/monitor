import { Injectable } from '@nestjs/common';
import { StoredAnomalyEvent } from '../interfaces/storage-port.interface';

export type SavedAnomaly = Pick<
  StoredAnomalyEvent,
  'id' | 'timestamp' | 'metricType' | 'anomalyType' | 'connectionId'
>;

type SavedAnomalyListener = (event: SavedAnomaly) => void;

@Injectable()
export class AnomalySavedBus {
  private readonly listeners = new Set<SavedAnomalyListener>();

  subscribe(listener: SavedAnomalyListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: SavedAnomaly): void {
    for (const listener of this.listeners) listener(event);
  }
}
