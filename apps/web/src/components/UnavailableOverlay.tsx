import { Card, CardContent } from './ui/card';

interface Props {
  featureName: string;
  command: string;
  children: React.ReactNode;
}

export function UnavailableOverlay({ featureName, command, children }: Props) {
  return (
    <div className="relative">
      <div className="opacity-40 pointer-events-none">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <Card className="max-w-md shadow-lg">
          <CardContent className="pt-6 text-center space-y-2">
            <p className="text-lg font-semibold">{featureName} Unavailable</p>
            <p className="text-sm text-muted-foreground">
              The <code className="px-1 py-0.5 bg-muted rounded text-xs">{command}</code> command
              is blocked by this database instance. This is common with managed services
              (e.g. AWS ElastiCache Serverless) that restrict certain commands.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
