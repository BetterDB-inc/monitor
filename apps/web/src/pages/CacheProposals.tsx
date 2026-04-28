import { useEffect, useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCacheProposalsUnread } from '../hooks/useCacheProposals';
import { PendingList } from '../components/pages/cache-proposals/PendingList';
import { HistoryTable } from '../components/pages/cache-proposals/HistoryTable';

type View = 'pending' | 'history';

export function CacheProposals() {
  const [view, setView] = useState<View>('pending');
  const { markAllRead } = useCacheProposalsUnread();

  useEffect(() => {
    if (view === 'pending') {
      markAllRead();
    }
  }, [view, markAllRead]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Cache Proposals</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review optimization proposals submitted by agents via the MCP server.
        </p>
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <TabsList>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="pending" className="mt-6">
          <PendingList />
        </TabsContent>
        <TabsContent value="history" className="mt-6">
          <HistoryTable />
        </TabsContent>
      </Tabs>
    </div>
  );
}
