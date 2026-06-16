export type EmbedFn = (text: string) => Promise<number[]>;

export interface MemoryStoreClient {
  call(command: string, ...args: (string | Buffer | number)[]): Promise<unknown>;
}

export interface MemoryScope {
  threadId?: string;
  agentId?: string;
  namespace?: string;
}

export interface RememberOptions extends MemoryScope {
  importance?: number;
  tags?: string[];
  source?: string;
}
