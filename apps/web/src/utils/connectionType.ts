import type { Connection } from '../hooks/useConnection';

type WithType = Pick<Connection, 'connectionType'> | null | undefined;

export function isExternalConnection(connection: WithType): boolean {
  return connection?.connectionType === 'external';
}

export function connectionTypeSuffix(connection: WithType): string {
  if (connection?.connectionType === 'agent') {
    return ' · via agent';
  }
  if (connection?.connectionType === 'external') {
    return ' · OTLP push';
  }
  return ' · direct';
}
