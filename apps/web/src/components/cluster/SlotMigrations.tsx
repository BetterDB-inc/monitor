import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { ArrowRight, Database } from 'lucide-react';
import type { SlotMigration } from '../../types/cluster';

interface SlotMigrationsProps {
  migrations?: SlotMigration[];
}

export function SlotMigrations({ migrations }: SlotMigrationsProps) {
  const activeMigrations = migrations || [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            Slot Migrations
          </CardTitle>
          {activeMigrations.length > 0 && (
            <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/20">
              {activeMigrations.length} Active
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {activeMigrations.length === 0 ? (
          <div className="text-center py-8">
            <Database className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
            <div className="text-sm text-muted-foreground">
              No active slot migrations
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {activeMigrations.map((migration) => {
              const stateColor = migration.state === 'migrating'
                ? 'text-blue-500'
                : 'text-purple-500';

              const stateBg = migration.state === 'migrating'
                ? 'bg-blue-500/10'
                : 'bg-purple-500/10';

              return (
                <div
                  key={`${migration.slot}-${migration.sourceNodeId}-${migration.targetNodeId}`}
                  className="p-4 border rounded-lg space-y-3"
                >
                  {/* Header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Database className={`w-4 h-4 ${stateColor}`} />
                      <span className="font-medium">Slot {migration.slot}</span>
                      <Badge className={`${stateBg} ${stateColor} border-0 capitalize text-xs`}>
                        {migration.state}
                      </Badge>
                    </div>
                    {migration.keysRemaining !== undefined && (
                      <div className="text-xs font-medium">
                        {migration.keysRemaining.toLocaleString()} keys remaining
                      </div>
                    )}
                  </div>

                  {/* Migration Flow */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 space-y-1">
                      <div className="text-xs text-muted-foreground">Source</div>
                      <div className="text-sm font-medium truncate" title={migration.sourceAddress}>
                        {migration.sourceAddress}
                      </div>
                    </div>

                    <ArrowRight className={`w-5 h-5 ${stateColor} flex-shrink-0`} />

                    <div className="flex-1 space-y-1">
                      <div className="text-xs text-muted-foreground">Target</div>
                      <div className="text-sm font-medium truncate" title={migration.targetAddress}>
                        {migration.targetAddress}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Info */}
            <div className="pt-3 border-t text-xs text-muted-foreground">
              <div className="space-y-1">
                <div>
                  <strong className="text-blue-500">Migrating:</strong> Keys are being moved from source to target
                </div>
                <div>
                  <strong className="text-purple-500">Importing:</strong> Keys are being received at target
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
