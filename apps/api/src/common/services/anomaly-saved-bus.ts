import { Injectable, Logger } from '@nestjs/common';
import { StoredAnomalyEvent } from '../interfaces/storage-port.interface';

export type SavedAnomaly = Pick<
  StoredAnomalyEvent,
  'id' | 'timestamp' | 'metricType' | 'anomalyType' | 'connectionId'
>;

type SavedAnomalyListener = (event: SavedAnomaly) => void;

@Injectable()
export class AnomalySavedBus {
  private readonly logger = new Logger(AnomalySavedBus.name);
  private readonly listeners = new Set<SavedAnomalyListener>();

  subscribe(listener: SavedAnomalyListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: SavedAnomaly): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error(`Saved anomaly listener failed for ${event.id}`, err);
      }
    }
  }
}
