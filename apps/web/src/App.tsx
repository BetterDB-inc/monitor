import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Tooltip } from 'react-tooltip';
import { metricsApi } from './api/metrics';
import { CapabilitiesContext } from './hooks/useCapabilities';
import { LicenseContext, useLicenseStatus, useLicense } from './hooks/useLicense';
import { UpgradePromptContext, useUpgradePromptState } from './hooks/useUpgradePrompt';
import { UpgradePrompt } from './components/UpgradePrompt';
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
import { Settings } from './pages/Settings';
import type { DatabaseCapabilities } from './types/metrics';
import { Feature } from '@betterdb/shared';

function App() {
  const [capabilities, setCapabilities] = useState<DatabaseCapabilities | null>(null);
  const { license } = useLicenseStatus();
  const upgradePromptState = useUpgradePromptState();

  useEffect(() => {
    metricsApi.getHealth()
      .then(health => {
        if (health.capabilities) {
          setCapabilities(health.capabilities);
        }
      })
      .catch(console.error);
  }, []);

  return (
    <BrowserRouter>
      <UpgradePromptContext.Provider value={upgradePromptState}>
        <LicenseContext.Provider value={license}>
          <CapabilitiesContext.Provider value={capabilities}>
            <AppLayout />
            <Tooltip id="license-tooltip" />
            {upgradePromptState.error && (
              <UpgradePrompt
                error={upgradePromptState.error}
                onDismiss={upgradePromptState.dismissUpgradePrompt}
              />
            )}
          </CapabilitiesContext.Provider>
        </LicenseContext.Provider>
      </UpgradePromptContext.Provider>
    </BrowserRouter>
  );
}

function AppLayout() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed left-0 top-0 z-40 h-screen w-64 border-r bg-card flex flex-col">
        <div className="p-6">
          <h2 className="text-lg font-semibold">BetterDB Monitor</h2>
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
            href="https://github.com/betterdb-inc/monitor/issues/new"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
          >
            Report a Problem
          </a>
          <NavItem to="/settings" active={location.pathname === '/settings'}>
            Settings
          </NavItem>
        </div>
      </aside>

      <main className="pl-64 min-h-screen flex flex-col">
        <div className="p-8 flex-1 flex flex-col">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/slowlog" element={<SlowLog />} />
            <Route path="/latency" element={<Latency />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/client-analytics" element={<ClientAnalytics />} />
            <Route path="/client-analytics/deep-dive" element={<ClientAnalyticsDeepDive />} />
            <Route path="/anomalies" element={<AnomalyDashboard />} />
            <Route path="/key-analytics" element={<KeyAnalytics />} />
            <Route path="/audit" element={<AuditTrail />} />
            <Route path="/helper" element={<AiAssistant />} />
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
