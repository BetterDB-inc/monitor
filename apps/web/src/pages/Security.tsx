import { FindingsTable } from '../components/pages/security/FindingsTable';
import { HeaderStrip } from '../components/pages/security/HeaderStrip';
import { NotScannedList } from '../components/pages/security/NotScannedList';
import { VerdictCard } from '../components/pages/security/VerdictCard';
import { useCveDataset, useCveScan, useRefreshCveScan } from '../hooks/useCveScan';

const PRODUCT_LABEL: Record<string, string> = { valkey: 'Valkey', redis: 'Redis' };

export function Security() {
  const scan = useCveScan();
  const dataset = useCveDataset();
  const refresh = useRefreshCveScan();

  if (scan.isLoading) {
    return <p className="text-muted-foreground p-8 text-sm">Scanning this connection…</p>;
  }

  if (scan.isError || !scan.data || scan.data.nodes.length === 0) {
    return <p className="text-destructive p-8 text-sm">Could not scan this connection for CVEs.</p>;
  }

  const result = scan.data;
  const node = result.nodes[0];

  return (
    <div className="space-y-6">
      <HeaderStrip
        product={PRODUCT_LABEL[node.product] ?? node.product}
        version={node.engineVersion}
        severityCounts={node.severityCounts}
        dataset={dataset.data}
        refreshing={refresh.isPending}
        onRefresh={() => {
          refresh.mutate();
        }}
      />
      <VerdictCard
        version={node.engineVersion}
        severityCounts={node.severityCounts}
        findings={node.findings}
      />
      <FindingsTable findings={node.findings} unversioned={node.unversioned} showChips />
      <NotScannedList nodes={result.notScanned} />
    </div>
  );
}

export default Security;
