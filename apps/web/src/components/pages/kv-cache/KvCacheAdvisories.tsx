import { Alert, AlertDescription, AlertTitle } from '../../ui/alert';
import type { Advisory } from './kv-cache-format';

interface Props {
  advisories: Advisory[];
}

export function KvCacheAdvisories({ advisories }: Props) {
  if (advisories.length === 0) return null;
  return (
    <div className="space-y-3">
      {advisories.map((advisory) => (
        <Alert key={advisory.kind}>
          <AlertTitle>{advisory.title}</AlertTitle>
          <AlertDescription>{advisory.body}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
