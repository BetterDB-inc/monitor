import { useState } from 'react';
import { DriftBanner } from '../components/pages/security/DriftBanner';
import { DriftFindingsCard } from '../components/pages/security/DriftFindingsCard';
import { FindingsTable } from '../components/pages/security/FindingsTable';
import { HeaderStrip } from '../components/pages/security/HeaderStrip';
import { NodeList } from '../components/pages/security/NodeList';
import { NotScannedList } from '../components/pages/security/NotScannedList';
import { SourceStrip } from '../components/pages/security/SourceStrip';
import { VerdictCard } from '../components/pages/security/VerdictCard';
import { groupFindings, type NodeGroups } from '../components/pages/security/drift-groups';
import { useCveDataset, useCveScan, useRefreshCveScan } from '../hooks/useCveScan';

const PRODUCT_LABEL: Record<string, string> = { valkey: 'Valkey', redis: 'Redis' };
const EMPTY_GROUPS: NodeGroups = { unique: [], shared: [], unversioned: [], badge: 0 };

export function Security() {
  const scan = useCveScan();
  const dataset = useCveDataset();
  const refresh = useRefreshCveScan();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  if (scan.isLoading) {
    return <p className="text-muted-foreground p-8 text-sm">Scanning this connection…</p>;
  }

  if (scan.isError || !scan.data || scan.data.nodes.length === 0) {
    return <p className="text-destructive p-8 text-sm">Could not scan this connection for CVEs.</p>;
  }

  const result = scan.data;
  const drifted = result.distinctVersions.length > 1;
  const groups = groupFindings(result.nodes);
  const selected =
    result.nodes.find((entry) => {
      return entry.nodeId === selectedNodeId;
    }) ?? result.nodes[0];

  return (
    <div className="space-y-6">
      <HeaderStrip
        product={PRODUCT_LABEL[selected.product] ?? selected.product}
        version={drifted ? result.distinctVersions.join(', ') : selected.engineVersion}
        severityCounts={selected.severityCounts}
        dataset={dataset.data}
        refreshing={refresh.isPending}
        onRefresh={() => {
          refresh.mutate();
        }}
      />
      {drifted ? (
        <>
          <DriftBanner versions={result.distinctVersions} nodeCount={result.nodes.length} />
          <NodeList
            nodes={result.nodes}
            groups={groups}
            selectedNodeId={selected.nodeId}
            onSelect={setSelectedNodeId}
          />
          <DriftFindingsCard
            node={selected}
            groups={groups.get(selected.nodeId) ?? EMPTY_GROUPS}
            clusterSize={result.nodes.length}
          />
        </>
      ) : (
        <>
          <VerdictCard
            version={selected.engineVersion}
            severityCounts={selected.severityCounts}
            findings={selected.findings}
          />
          <FindingsTable
            findings={selected.findings}
            unversioned={selected.unversioned}
            showChips
          />
        </>
      )}
      <SourceStrip sources={dataset.data?.sources ?? []} missingSources={result.missingSources} />
      <NotScannedList nodes={result.notScanned} />
    </div>
  );
}

export default Security;
