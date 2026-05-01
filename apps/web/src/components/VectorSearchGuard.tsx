import { Card, CardContent } from './ui/card';
import { useCapabilities } from '../hooks/useCapabilities';

interface Props {
  featureName: string;
  description: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Route-level guard for pages that only make sense on connections with the
 * Valkey/Redis Search module loaded. When the capability is missing, the
 * children are never mounted — so downstream hooks never register queries,
 * even with `enabled: false` gates. Use at the route element, inside
 * NoConnectionsGuard.
 */
export function VectorSearchGuard({ featureName, description, children }: Props) {
  const { hasVectorSearch } = useCapabilities();
  if (hasVectorSearch) {
    return <>{children}</>;
  }
  return (
    <div className="flex items-center justify-center py-16">
      <Card className="max-w-md shadow-lg">
        <CardContent className="pt-6 text-center space-y-2">
          <p className="text-lg font-semibold">{featureName} Unavailable</p>
          <p className="text-sm text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </div>
  );
}
