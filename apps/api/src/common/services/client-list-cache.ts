import { Injectable } from '@nestjs/common';
import { ClientInfo } from '../types/metrics.types';

export type CachedClient = Pick<ClientInfo, 'id' | 'addr' | 'name' | 'user' | 'flags'> & {
  'tot-cmds'?: unknown;
};

export interface ClientListCapture {
  takenAt: number;
  clients: CachedClient[];
}

@Injectable()
export class ClientListCache {
  private readonly captures = new Map<string, ClientListCapture>();

  record(connectionId: string, clients: ClientInfo[], takenAt: number): void {
    this.captures.set(connectionId, {
      takenAt,
      clients: clients.map(({ id, addr, name, user, flags, 'tot-cmds': totalCommands }) => ({
        id,
        addr,
        name,
        user,
        flags,
        'tot-cmds': totalCommands,
      })),
    });
  }

  latest(connectionId: string): ClientListCapture | undefined {
    return this.captures.get(connectionId);
  }

  forget(connectionId: string): void {
    this.captures.delete(connectionId);
  }
}
