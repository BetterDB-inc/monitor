import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Tooltip } from 'react-tooltip';
import { metricsApi } from './api/metrics';
import { CapabilitiesContext } from './hooks/useCapabilities';
import { LicenseContext, useLicenseStatus, useLicense } from './hooks/useLicense';
import { UpgradePromptContext, useUpgradePromptState } from './hooks/useUpgradePrompt';
import { ConnectionContext, useConnectionState } from './hooks/useConnection';
import { VersionCheckContext, useVersionCheckState } from './hooks/useVersionCheck';
import { UpgradePrompt } from './components/UpgradePrompt';
import { UpdateBanner } from './components/UpdateBanner';
import { ConnectionSelector } from './components/ConnectionSelector';
import { NoConnectionsGuard } from './components/NoConnectionsGuard';
import { ServerStartupGuard } from './components/ServerStartupGuard';
import { Dashboard } from './pages/Dashboard';
import { SlowLog } from './pages/SlowLog';
import { Latency } from './pages/Latency';
import { Clients } from './pages/Clients';
import { AuditTrail } from './pages/AuditTrail';
import { ClientAnalytics } from './pages/ClientAnalytics';
import { ClientAnalyticsDeepDive } from './pages/ClientAnalyticsDeepDive';
import { AiAssistant } from './pages/AiAssistant';
import { AnomalyDashboard } from './pages/AnomalyDashboard';
import { KeyAnalytics } from './pages/KeyAnalytics';
import { ClusterDashboard } from './pages/ClusterDashboard';
import { Settings } from './pages/Settings';
import { Webhooks } from './pages/Webhooks';
import { Members } from './pages/Members';
import { workspaceApi, CloudUser } from './api/workspace';
import type { DatabaseCapabilities } from './types/metrics';
import { Feature } from '@betterdb/shared';

function App() {
  return (
    <ServerStartupGuard>
      <AppContent />
    </ServerStartupGuard>
  );
}

/**
 * AppContent contains all hooks and providers.
 * It only mounts AFTER ServerStartupGuard confirms the server is ready,
 * ensuring all data fetching happens when the backend is fully initialized.
 */
function AppContent() {
  const [capabilities, setCapabilities] = useState<DatabaseCapabilities | null>(null);
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);
  const { license } = useLicenseStatus();
  const upgradePromptState = useUpgradePromptState();
  const connectionState = useConnectionState();
  const versionCheckState = useVersionCheckState();

  useEffect(() => {
    metricsApi.getHealth()
      .then(health => {
        if (health.capabilities) {
          setCapabilities(health.capabilities);
        }
      })
      .catch(console.error);

    workspaceApi.getMe()
      .then(setCloudUser)
      .catch(() => { /* Not in cloud mode */ });
  }, []);

  return (
    <BrowserRouter>
      <ConnectionContext.Provider value={connectionState}>
        <UpgradePromptContext.Provider value={upgradePromptState}>
          <LicenseContext.Provider value={license}>
            <CapabilitiesContext.Provider value={capabilities}>
              <VersionCheckContext.Provider value={versionCheckState}>
                <AppLayout cloudUser={cloudUser} />
                <Tooltip id="license-tooltip" />
                {upgradePromptState.error && (
                  <UpgradePrompt
                    error={upgradePromptState.error}
                    onDismiss={upgradePromptState.dismissUpgradePrompt}
                  />
                )}
              </VersionCheckContext.Provider>
            </CapabilitiesContext.Provider>
          </LicenseContext.Provider>
        </UpgradePromptContext.Provider>
      </ConnectionContext.Provider>
    </BrowserRouter>
  );
}

function AppLayout({ cloudUser }: { cloudUser: CloudUser | null }) {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed left-0 top-0 z-40 h-screen w-64 border-r bg-card flex flex-col">
        <div className="p-6 pb-2">
          <h2 className="text-lg font-semibold">BetterDB Monitor</h2>
        </div>
        <div className="border-b pb-2 mb-2">
          <ConnectionSelector isCloudMode={!!cloudUser} />
        </div>
        <nav className="space-y-1 px-3 flex-1">
          <NavItem to="/" active={location.pathname === '/'}>
            Dashboard
          </NavItem>
          <NavItem to="/slowlog" active={location.pathname === '/slowlog'}>
            Slow Log
          </NavItem>
          <NavItem to="/latency" active={location.pathname === '/latency'}>
            Latency
          </NavItem>
          <NavItem to="/clients" active={location.pathname === '/clients'}>
            Clients
          </NavItem>
          <NavItem to="/client-analytics" active={location.pathname === '/client-analytics'}>
            Client Analytics
          </NavItem>
          <NavItem to="/client-analytics/deep-dive" active={location.pathname === '/client-analytics/deep-dive'}>
            Analytics Deep Dive
          </NavItem>
          <NavItem to="/cluster" active={location.pathname === '/cluster'}>
            Cluster
          </NavItem>
          <NavItem
            to="/anomalies"
            active={location.pathname === '/anomalies'}
            requiredFeature={Feature.ANOMALY_DETECTION}
          >
            Anomaly Detection
          </NavItem>
          <NavItem
            to="/key-analytics"
            active={location.pathname === '/key-analytics'}
            requiredFeature={Feature.KEY_ANALYTICS}
          >
            Key Analytics
          </NavItem>
          <NavItem to="/audit" active={location.pathname === '/audit'}>
            Audit Trail
          </NavItem>
          <NavItem to="/webhooks" active={location.pathname === '/webhooks'}>
            Webhooks
          </NavItem>
          <NavItem to="/helper" active={location.pathname === '/helper'}>
            <span className="flex items-center justify-between w-full">
              AI Helper
              <span className="text-[10px] px-1.5 py-0.5 bg-amber-500 text-amber-950 rounded font-medium">
                Experimental
              </span>
            </span>
          </NavItem>
        </nav>
        <div className="px-3 pb-4 border-t border-gray-200 pt-2 space-y-1">
          <a
            href="https://docs.betterdb.com"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
          >
            Documentation
          </a>
          <a
            href="https://github.com/betterdb-inc/monitor/issues/new"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
          >
            Report a Problem
          </a>
          {cloudUser && (
            <NavItem to="/workspace/members" active={location.pathname === '/workspace/members'}>
              Team
            </NavItem>
          )}
          <NavItem to="/settings" active={location.pathname === '/settings'}>
            Settings
          </NavItem>
        </div>
      </aside>

      <main className="pl-64 min-h-screen flex flex-col">
        <UpdateBanner />
        <div className="p-8 flex-1 flex flex-col">
          <Routes>
            <Route path="/" element={<NoConnectionsGuard><Dashboard /></NoConnectionsGuard>} />
            <Route path="/slowlog" element={<NoConnectionsGuard><SlowLog /></NoConnectionsGuard>} />
            <Route path="/latency" element={<NoConnectionsGuard><Latency /></NoConnectionsGuard>} />
            <Route path="/clients" element={<NoConnectionsGuard><Clients /></NoConnectionsGuard>} />
            <Route path="/client-analytics" element={<NoConnectionsGuard><ClientAnalytics /></NoConnectionsGuard>} />
            <Route path="/client-analytics/deep-dive" element={<NoConnectionsGuard><ClientAnalyticsDeepDive /></NoConnectionsGuard>} />
            <Route path="/anomalies" element={<NoConnectionsGuard><AnomalyDashboard /></NoConnectionsGuard>} />
            <Route path="/key-analytics" element={<NoConnectionsGuard><KeyAnalytics /></NoConnectionsGuard>} />
            <Route path="/cluster" element={<NoConnectionsGuard><ClusterDashboard /></NoConnectionsGuard>} />
            <Route path="/audit" element={<NoConnectionsGuard><AuditTrail /></NoConnectionsGuard>} />
            <Route path="/helper" element={<NoConnectionsGuard><AiAssistant /></NoConnectionsGuard>} />
            <Route path="/webhooks" element={<NoConnectionsGuard><Webhooks /></NoConnectionsGuard>} />
            {cloudUser && (
              <Route path="/workspace/members" element={<Members cloudUser={cloudUser} />} />
            )}
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

interface NavItemProps {
  children: React.ReactNode;
  active: boolean;
  to: string;
  requiredFeature?: Feature;
}

function NavItem({ children, active, to, requiredFeature }: NavItemProps) {
  const { hasFeature, tier } = useLicense();

  const isLocked = requiredFeature && !hasFeature(requiredFeature);
  const tooltipText = isLocked
    ? `This feature requires a Pro or Enterprise license. Current tier: ${tier}`
    : undefined;

  if (isLocked) {
    return (
      <div
        data-tooltip-id="license-tooltip"
        data-tooltip-content={tooltipText}
        className="block w-full rounded-md px-3 py-2 text-sm opacity-50 cursor-not-allowed flex items-center justify-between"
      >
        <span>{children}</span>
        <span className="text-[10px] px-1.5 py-0.5 bg-yellow-500 text-yellow-950 rounded font-medium">
          Pro+
        </span>
      </div>
    );
  }

  return (
    <Link
      to={to}
      className={`block w-full rounded-md px-3 py-2 text-sm transition-colors ${active
        ? 'bg-primary text-primary-foreground'
        : 'hover:bg-muted'
        }`}
    >
      {children}
    </Link>
  );
}

export default App;
