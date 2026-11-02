import { Injectable } from '@nestjs/common';
import { ClientInfo } from '../types/metrics.types';

export interface ClientListCapture {
  takenAt: number;
  clients: ClientInfo[];
}

@Injectable()
export class ClientListCache {
  private readonly captures = new Map<string, ClientListCapture>();

  record(connectionId: string, clients: ClientInfo[], takenAt: number): void {
    this.captures.set(connectionId, { takenAt, clients });
  }

  latest(connectionId: string): ClientListCapture | undefined {
    return this.captures.get(connectionId);
  }

  forget(connectionId: string): void {
    this.captures.delete(connectionId);
  }
}
