export type CliResultType = 'string' | 'integer' | 'array' | 'nil' | 'error' | 'empty-array';

export interface CliExecuteMessage {
  type: 'execute';
  command: string;
  connectionId?: string;
}

export interface CliResultMessage {
  type: 'result';
  result: string;
  resultType: CliResultType;
  durationMs: number;
}

export interface CliErrorMessage {
  type: 'error';
  error: string;
}

export type CliServerMessage = CliResultMessage | CliErrorMessage;
