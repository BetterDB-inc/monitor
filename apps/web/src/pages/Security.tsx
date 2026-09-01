import { useState } from 'react';
import type { CveSeverityCounts, ScannedNode } from '@betterdb/shared';
import { DriftBanner } from '../components/pages/security/DriftBanner';
import { DriftFindingsCard } from '../components/pages/security/DriftFindingsCard';
import { EmptyScanCard } from '../components/pages/security/EmptyScanCard';
import { FailedScanCard } from '../components/pages/security/FailedScanCard';
import { FindingsTable } from '../components/pages/security/FindingsTable';
import { HeaderStrip } from '../components/pages/security/HeaderStrip';
import { NodeList } from '../components/pages/security/NodeList';
import { NotScannedList } from '../components/pages/security/NotScannedList';
import { ScanCaveats } from '../components/pages/security/ScanCaveats';
import { SourceStrip } from '../components/pages/security/SourceStrip';
import { VerdictCard } from '../components/pages/security/VerdictCard';
import { groupFindings, type NodeGroups } from '../components/pages/security/drift-groups';
import { datasetAgeLabel, scanAgeLabel } from '../components/pages/security/header-labels';
import { datasetCaveats, scanCompleteness } from '../components/pages/security/scan-completeness';
import { parseScanFailure, scanErrorMessage } from '../components/pages/security/scan-error';
import { scanFailureCopy } from '../components/pages/security/scan-failure-copy';
import { useCveDataset, useCveScan, useRefreshCveScan } from '../hooks/useCveScan';

const PRODUCT_LABEL: Record<string, string> = { valkey: 'Valkey', redis: 'Redis' };
const EMPTY_GROUPS: NodeGroups = { unique: [], shared: [], unversioned: [], badge: 0 };
const SCAN_FAILED_MESSAGE = 'The server did not return a scan for this connection.';
const NO_NODE_MESSAGE = 'No node in this connection could be scanned.';

function clusterSeverity(nodes: ScannedNode[]): CveSeverityCounts {
  return nodes.reduce<CveSeverityCounts>(
    (total, entry) => {
      return {
        critical: total.critical + entry.severityCounts.critical,
        high: total.high + entry.severityCounts.high,
        medium: total.medium + entry.severityCounts.medium,
        low: total.low + entry.severityCounts.low,
      };
    },
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
}

export function Security() {
  const scan = useCveScan();
  const dataset = useCveDataset();
  const refresh = useRefreshCveScan();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const refreshError = refresh.isError
    ? scanErrorMessage(refresh.error, SCAN_FAILED_MESSAGE)
    : null;

  if (scan.isPending) {
    return <p className="text-muted-foreground p-8 text-sm">Scanning this connection…</p>;
  }

  if (scan.isError || scan.data === undefined) {
    const failure = parseScanFailure(scan.error, SCAN_FAILED_MESSAGE);
    const copy = scanFailureCopy(failure.summary, failure.nodes);

    return (
      <div className="flex min-h-full flex-col gap-6">
        <HeaderStrip
          subtitle="Could not scan this connection for CVEs."
          severityCounts={null}
          severityUnknown
          scopeLabel={null}
          refreshing={scan.isFetching}
          refreshError={refreshError}
          onRefresh={() => {
            void scan.refetch();
          }}
        />
        <FailedScanCard
          headline={copy.headline}
          detail={copy.detail}
          summary={failure.summary}
          guidance={copy.guidance}
          nodes={failure.nodes}
          sources={dataset.data?.sources ?? []}
          retrying={scan.isFetching}
          onRetry={() => {
            void scan.refetch();
          }}
        />
      </div>
    );
  }

  const result = scan.data;
  const completeness = scanCompleteness(result);
  const onRefresh = () => {
    refresh.mutate();
  };

  if (result.nodes.length === 0) {
    const nodes = result.notScanned.map((entry) => {
      return { address: entry.address, reason: entry.reason };
    });
    const copy = scanFailureCopy(NO_NODE_MESSAGE, nodes);

    return (
      <div className="flex min-h-full flex-col gap-6">
        <HeaderStrip
          subtitle="No node in this connection could be scanned."
          severityCounts={null}
          severityUnknown
          scopeLabel={null}
          refreshing={refresh.isPending}
          refreshError={refreshError}
          onRefresh={onRefresh}
        />
        <FailedScanCard
          headline={copy.headline}
          detail={copy.detail}
          summary={NO_NODE_MESSAGE}
          guidance={copy.guidance}
          nodes={nodes}
          sources={dataset.data?.sources ?? []}
          retrying={refresh.isPending}
          onRetry={onRefresh}
        />
      </div>
    );
  }

  const drifted = result.drift;
  const groups = groupFindings(result.nodes);
  const selected =
    result.nodes.find((entry) => {
      return entry.nodeId === selectedNodeId;
    }) ?? result.nodes[0];
  const product = PRODUCT_LABEL[selected.product] ?? selected.product;
  const version = drifted ? result.distinctVersions.join(', ') : selected.engineVersion;
  const subtitle = [
    `${product} ${version}`,
    scanAgeLabel(result.scannedAt, result.lastCheckedAt),
    datasetAgeLabel(dataset.data?.refreshedAt),
  ].join(' · ');

  const datasetUnreadable = dataset.isError || dataset.isPending;
  const ghsaTokenMissing =
    dataset.data?.ghsaAuthenticated === false &&
    (result.missingSources.includes('ghsa') ||
      (dataset.data?.sources ?? []).some((source) => {
        return source.source === 'ghsa' && source.state !== 'ok';
      }));
  const nothingToList =
    drifted === false &&
    datasetUnreadable === false &&
    result.nodes.every((entry) => {
      return entry.findings.length === 0 && entry.unversioned.length === 0;
    });

  const header = (
    <HeaderStrip
      subtitle={subtitle}
      severityCounts={clusterSeverity(result.nodes)}
      scopeLabel={result.nodes.length > 1 ? `across ${result.nodes.length} nodes` : null}
      refreshing={refresh.isPending}
      refreshError={refreshError}
      onRefresh={onRefresh}
    />
  );

  if (nothingToList) {
    return (
      <div className="flex flex-1 flex-col space-y-6">
        {header}
        <EmptyScanCard
          engineLabel={`${PRODUCT_LABEL[selected.product] ?? selected.product} ${selected.engineVersion}`}
          caveats={[...completeness.caveats, ...datasetCaveats(dataset.data)]}
          sources={dataset.data?.sources ?? []}
          advisoryCount={dataset.data?.advisoryCount ?? 0}
          ghsaTokenMissing={ghsaTokenMissing}
        />
        <NotScannedList nodes={result.notScanned} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <ScanCaveats caveats={completeness.caveats} />
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
            uncheckedCount={selected.unversioned.length}
            incomplete={completeness.complete === false}
          />
          <FindingsTable
            findings={selected.findings}
            unversioned={selected.unversioned}
            showChips
          />
        </>
      )}
      <SourceStrip
        sources={dataset.data?.sources ?? []}
        missingSources={result.missingSources}
        loading={dataset.isPending}
        failed={dataset.isError}
      />
      <NotScannedList nodes={result.notScanned} />
    </div>
  );
}

export default Security;
