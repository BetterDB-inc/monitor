import { metricsApi } from '../api/metrics';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { useCapabilities } from '../hooks/useCapabilities';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { ClientsTable } from '../components/metrics/ClientsTable';
import { UnavailableOverlay } from '../components/UnavailableOverlay';

export function Clients() {
  const { currentConnection } = useConnection();
  const { hasClientList } = useCapabilities();
  const { data: clients } = usePolling({
    fetcher: metricsApi.getClients,
    interval: 10000,
    refetchKey: currentConnection?.id,
  });

  const content = (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Connected Clients</h1>

      <Card>
        <CardHeader>
          <CardTitle>Active Connections ({clients?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          <ClientsTable clients={clients || []} />
        </CardContent>
      </Card>
    </div>
  );

  if (!hasClientList) {
    return (
      <UnavailableOverlay featureName="Clients" command="CLIENT LIST">
        {content}
      </UnavailableOverlay>
    );
  }

  return content;
}
