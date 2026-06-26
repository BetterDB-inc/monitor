export interface RecallScopeDto {
  threadId?: string;
  agentId?: string;
  namespace?: string;
}

export interface RecallBodyDto {
  vector: number[];
  k?: number;
  threshold?: number;
  tags?: string[];
  scope?: RecallScopeDto;
}
