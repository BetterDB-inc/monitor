import { MessagesSquare } from 'lucide-react';
import { EmptyState } from '../../ui/empty-state';
import { Button } from '../../ui/button';

export const EMPTY_STATE_COPY =
  'BetterDB reads session state only from Valkey keys you point it at';

export function SessionExplorerEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon={MessagesSquare}
      title="No session namespaces yet"
      description={EMPTY_STATE_COPY}
      action={<Button onClick={onCreate}>Add namespace</Button>}
    />
  );
}
