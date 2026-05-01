import { useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useIdleTracker } from '../../hooks/useIdleTracker';
import { useNavigationTracker } from '../../hooks/useNavigationTracker';
import { useCliPanel } from '../../hooks/useCliPanel';
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
import { KeyAnalytics } from '../../pages/KeyAnalytics';
import { ClusterDashboard } from '../../pages/ClusterDashboard';
import { Settings } from '../../pages/Settings';
import { Webhooks } from '../../pages/Webhooks';
import { MigrationPage } from '../../pages/MigrationPage';
import { VectorSearch } from '../../pages/VectorSearch';
import { VectorAi } from '../../pages/VectorAi';
import { InferenceLatency } from '../../pages/InferenceLatency';
import { MetricForecasting } from '../../pages/MetricForecasting';
import { Members } from '../../pages/Members';
import { CloudUser } from '../../api/workspace';
import { AppSidebar } from './AppSidebar.tsx';
import { FeedbackModal } from './FeedbackModal';
import { SidebarProvider } from '@/components/ui/sidebar.tsx';

export function AppLayout({ cloudUser }: { cloudUser: CloudUser | null }) {
  const [showFeedback, setShowFeedback] = useState(false);
  const cliPanel = useCliPanel();
  useIdleTracker();
  useNavigationTracker();

  return (
    <SidebarProvider>
      <div className="min-h-screen bg-background w-full">
        <AppSidebar cloudUser={cloudUser} onFeedbackClick={() => setShowFeedback(true)} />

        {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}

        <main className="min-h-screen  flex flex-col pl-0 transition-[padding] duration-200 ease-linear md:peer-data-[state=expanded]:pl-64">
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
                  <NoConnectionsGuard>
                    <Webhooks />
                  </NoConnectionsGuard>
                }
              />
              <Route
                path="/migration"
                element={
                  <NoConnectionsGuard>
                    <MigrationPage />
                  </NoConnectionsGuard>
                }
              />
              {cloudUser && (
                <Route path="/workspace/members" element={<Members cloudUser={cloudUser} />} />
              )}
              <Route path="/settings" element={<Settings isCloudMode={!!cloudUser} />} />
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
    </SidebarProvider>
  );
}
