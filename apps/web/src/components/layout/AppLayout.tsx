import { ReactElement, useMemo, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { DemoBanner } from '../DemoBanner';
import { useIdleTracker } from '../../hooks/useIdleTracker';
import { useNavigationTracker } from '../../hooks/useNavigationTracker';
import { useCliPanel } from '../../hooks/useCliPanel';
import { useValkeyAutoLink } from '../../hooks/useValkeyAutoLink';
import { UpdateBanner } from '../UpdateBanner';
import { NoConnectionsGuard } from '../NoConnectionsGuard';
import { VectorSearchGuard } from '../VectorSearchGuard';
import { CliPanel } from '../CliPanel';
import { Dashboard } from '../../pages/Dashboard';
import { SlowLog } from '../../pages/SlowLog';
import { Latency } from '../../pages/Latency';
import { Clients } from '../../pages/Clients';
import { AuditTrail } from '../../pages/AuditTrail';
import { ClientAnalytics } from '../../pages/ClientAnalytics';
import { ClientAnalyticsDeepDive } from '../../pages/ClientAnalyticsDeepDive';
import { AiAssistant } from '../../pages/AiAssistant';
import { AnomalyDashboard } from '../../pages/AnomalyDashboard';
import { AiCacheMemory } from '../../pages/AiCacheMemory';
import { AiTraces } from '../../pages/AiTraces';
import { KeyAnalytics } from '../../pages/KeyAnalytics';
import { BulkDelete } from '../../pages/BulkDelete';
import { ClusterDashboard } from '../../pages/ClusterDashboard';
import { Settings } from '../../pages/Settings';
import { Webhooks } from '../../pages/Webhooks';
import { MigrationPage } from '../../pages/MigrationPage';
import { MigrationPlanProvider } from '../migration/MigrationPlanProvider';
import { VectorSearch } from '../../pages/VectorSearch';
import { VectorAi } from '../../pages/VectorAi';
import { InferenceLatency } from '../../pages/InferenceLatency';
import { MetricForecasting } from '../../pages/MetricForecasting';
import { CacheProposals } from '../../pages/CacheProposals';
import { Monitor } from '../../pages/Monitor';
import { MonitorSession } from '../../pages/MonitorSession';
import { Members } from '../../pages/Members';
import { Security } from '../../pages/Security';

import { useAuth } from '../../contexts/AuthContext';
import { AppSidebar } from './AppSidebar.tsx';
import { FeedbackModal } from './FeedbackModal';
import { RestrictedRoute } from './RestrictedRoute';
import { ShortcutsOverlay } from '@/components/layout/ShortcutsOverlay';
import { useAppKeybindings } from '@/keybindings/useAppKeybindings';
import { ConnectionSwitcherOpenContext } from '@/components/connection-selector/switcher-open-context';
import { useSidebar } from '@/components/ui/sidebar';
import { SidebarProvider } from '@/components/ui/sidebar.tsx';

export function AppLayout(): ReactElement {
  return (
    <SidebarProvider>
      <AppLayoutInner />
    </SidebarProvider>
  );
}

/**
 * Split out so the keybindings can reach `useSidebar`, which only exists
 * inside `SidebarProvider`.
 */
function AppLayoutInner(): ReactElement {
  const { user, isCloud, mode } = useAuth();
  const cloudUser = isCloud ? user : null;
  const showTeam = isCloud === true || mode === 'self-hosted';
  const [showFeedback, setShowFeedback] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const cliPanel = useCliPanel();
  const { toggleSidebar, isMobile, setOpen, setOpenMobile } = useSidebar();

  const switcherState = useMemo(() => {
    return { open: switcherOpen, setOpen: setSwitcherOpen };
  }, [switcherOpen]);

  useAppKeybindings(
    {
      toggleCli: cliPanel.toggle,
      toggleSidebar,
      openConnectionSwitcher: () => {
        // The switcher is inside the sidebar, so reveal that first — on mobile
        // it is a Sheet whose contents do not exist while closed.
        if (isMobile) {
          setOpenMobile(true);
        } else {
          setOpen(true);
        }
        setSwitcherOpen(true);
      },
      showShortcuts: () => setShowShortcuts(true),
    },
    { isCloud: cloudUser !== null, shortcutsOpen: showShortcuts },
  );
  useIdleTracker();
  useNavigationTracker();
  // Mirror ready managed Valkey instances into the connection list app-wide, so
  // linking doesn't depend on the Add Connection dialog staying open.
  useValkeyAutoLink(cloudUser);

  return (
    <ConnectionSwitcherOpenContext.Provider value={switcherState}>
      <div className="min-h-screen bg-background w-full">
        <AppSidebar
          cloudUser={cloudUser}
          showTeam={showTeam}
          onFeedbackClick={() => setShowFeedback(true)}
          onShortcutsClick={() => setShowShortcuts(true)}
        />

        {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
        {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}

        <main className="min-h-screen  flex flex-col pl-0 transition-[padding] duration-200 ease-linear md:peer-data-[state=expanded]:pl-64">
          <DemoBanner cloudUser={cloudUser} />
          {!cloudUser && <UpdateBanner />}
          <div className="p-8 flex-1 flex flex-col">
            <Routes>
              <Route
                path="/"
                element={
                  <NoConnectionsGuard>
                    <Dashboard />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/slowlog"
                element={
                  <NoConnectionsGuard>
                    <SlowLog />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/latency"
                element={
                  <NoConnectionsGuard>
                    <Latency />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/clients"
                element={
                  <NoConnectionsGuard>
                    <Clients />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/client-analytics"
                element={
                  <NoConnectionsGuard>
                    <ClientAnalytics />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/client-analytics/deep-dive"
                element={
                  <NoConnectionsGuard>
                    <ClientAnalyticsDeepDive />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/anomalies"
                element={
                  <NoConnectionsGuard>
                    <AnomalyDashboard />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/key-analytics"
                element={
                  <NoConnectionsGuard>
                    <KeyAnalytics />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/bulk-delete"
                element={
                  <RestrictedRoute>
                    <NoConnectionsGuard>
                      <BulkDelete />
                    </NoConnectionsGuard>
                  </RestrictedRoute>
                }
              />
              <Route
                path="/vector-search"
                element={
                  <NoConnectionsGuard>
                    <VectorSearch />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/vector-ai"
                element={
                  <NoConnectionsGuard>
                    <VectorAi />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/ai-cache-memory"
                element={
                  <NoConnectionsGuard>
                    <AiCacheMemory />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/ai-traces"
                element={
                  <NoConnectionsGuard>
                    <AiTraces />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/inference-latency"
                element={
                  <NoConnectionsGuard>
                    <VectorSearchGuard
                      featureName="Inference Latency"
                      description={
                        <>
                          The Valkey/Redis Search module is not available on this connection, so
                          there is no inference workload to analyse.
                        </>
                      }
                    >
                      <InferenceLatency />
                    </VectorSearchGuard>
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/cluster"
                element={
                  <NoConnectionsGuard>
                    <ClusterDashboard />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/forecasting"
                element={
                  <NoConnectionsGuard>
                    <MetricForecasting />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/security"
                element={
                  <NoConnectionsGuard>
                    <Security />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/audit"
                element={
                  <NoConnectionsGuard>
                    <AuditTrail />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/helper"
                element={
                  <NoConnectionsGuard>
                    <AiAssistant />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/webhooks"
                element={
                  <RestrictedRoute>
                    <NoConnectionsGuard>
                      <Webhooks />
                    </NoConnectionsGuard>
                  </RestrictedRoute>
                }
              />
              <Route
                path="/migration"
                element={
                  <NoConnectionsGuard>
                    <MigrationPlanProvider>
                      <MigrationPage isCloudMode={!!cloudUser} />
                    </MigrationPlanProvider>
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/cache-proposals"
                element={
                  <NoConnectionsGuard>
                    <CacheProposals />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/monitor"
                element={
                  <NoConnectionsGuard>
                    <Monitor />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/monitor/sessions/:id"
                element={
                  <NoConnectionsGuard>
                    <MonitorSession />
                  </NoConnectionsGuard>
                }
              />
              {showTeam && <Route path="/workspace/members" element={<Members />} />}
              <Route
                path="/settings"
                element={
                  <RestrictedRoute>
                    <Settings isCloudMode={!!cloudUser} />
                  </RestrictedRoute>
                }
              />
            </Routes>
          </div>
        </main>
        <CliPanel isOpen={cliPanel.isOpen} onToggle={cliPanel.toggle} onClose={cliPanel.close} />
        <style>{`
        @media print {
          [data-slot='sidebar'],
          [data-slot='sidebar-gap'],
          [data-slot='sidebar-container'],
          .print\\:hidden,
          nav {
            display: none !important;
          }
          main { padding-left: 0 !important; }
        }
      `}</style>
      </div>
    </ConnectionSwitcherOpenContext.Provider>
  );
}
