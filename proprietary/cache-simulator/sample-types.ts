import type { DatabasePort } from '@app/common/interfaces/database-port.interface';

export type SamplerClient = Pick<DatabasePort, 'call' | 'getClient' | 'getDbSize'>;

export interface Stratum {
  type: string;
  estimatedKeys: number;
  sizes: number[];
}

export interface NodeSample {
  node: string;
  dbSize: number;
  strata: Stratum[];
  exhausted: boolean;
  timedOut: boolean;
}
