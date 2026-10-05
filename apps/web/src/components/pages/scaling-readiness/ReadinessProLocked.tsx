import { Card, CardContent } from '../../ui/card';

export function ReadinessProLocked() {
  return (
    <Card>
      <CardContent className="space-y-1 pt-6">
        <p className="font-medium">Score history and alerts are available in Pro</p>
        <p className="text-sm text-muted-foreground">
          Upgrade to keep a history of this score and get a webhook when it drops.
        </p>
      </CardContent>
    </Card>
  );
}
