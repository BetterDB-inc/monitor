import type { ScannedNode } from '@betterdb/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { FindingsTable } from './FindingsTable';
import type { NodeGroups } from './drift-groups';

interface DriftFindingsCardProps {
  node: ScannedNode;
  groups: NodeGroups;
  clusterSize: number;
}

export function DriftFindingsCard({ node, groups, clusterSize }: DriftFindingsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {node.address} · {node.engineVersion}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <section data-testid="group-unique">
          <h3 className="mb-2 text-sm font-medium">Unique to this node ({groups.unique.length})</h3>
          <FindingsTable findings={groups.unique} unversioned={[]} />
        </section>
        <section data-testid="group-shared">
          <h3 className="mb-2 text-sm font-medium">
            Shared with all {clusterSize} nodes ({groups.shared.length})
          </h3>
          <FindingsTable findings={groups.shared} unversioned={[]} />
        </section>
        <section data-testid="group-unversioned">
          <h3 className="mb-2 text-sm font-medium">
            Not version-matched ({groups.unversioned.length})
          </h3>
          <FindingsTable findings={[]} unversioned={groups.unversioned} />
        </section>
      </CardContent>
    </Card>
  );
}
