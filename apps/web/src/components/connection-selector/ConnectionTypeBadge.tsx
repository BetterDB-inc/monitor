import type { Connection } from '../../hooks/useConnection';
import { isExternalConnection } from '../../utils/connectionType';

const BADGE = 'ms-1 shrink-0 rounded bg-muted px-1 text-[10px] font-medium uppercase';

export function ConnectionTypeBadge({ connection }: { connection: Connection }) {
  if (isExternalConnection(connection)) {
    return <span className={BADGE}>OTLP</span>;
  }
  if (connection.membership?.origin === 'auto') {
    return <span className={BADGE}>Auto</span>;
  }
  if (connection.membership?.origin === 'adopted') {
    return <span className={BADGE}>Adopted</span>;
  }
  return null;
}
