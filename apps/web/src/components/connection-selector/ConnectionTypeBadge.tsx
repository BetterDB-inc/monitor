import type { Connection } from '../../hooks/useConnection';
import { isExternalConnection } from '../../utils/connectionType';

export function ConnectionTypeBadge({ connection }: { connection: Connection }) {
  if (!isExternalConnection(connection)) {
    return null;
  }
  return (
    <span className="ms-1 rounded bg-muted px-1 text-[10px] font-medium uppercase">OTLP</span>
  );
}
