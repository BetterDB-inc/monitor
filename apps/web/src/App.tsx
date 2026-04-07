import { useState, useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { Tooltip } from 'react-tooltip';
import { TooltipProvider } from '@/components/ui/tooltip';
import { metricsApi } from './api/metrics';
import { CapabilitiesContext, CapabilitiesState } from './hooks/useCapabilities';
import { LicenseContext, useLicenseStatus } from './hooks/useLicense';
import { UpgradePromptContext, useUpgradePromptState } from './hooks/useUpgradePrompt';
import { ConnectionContext, useConnectionState } from './hooks/useConnection';
import { VersionCheckContext, useVersionCheckState } from './hooks/useVersionCheck';
import { UpgradePrompt } from './components/UpgradePrompt';
import { ServerStartupGuard } from './components/ServerStartupGuard';
import { AppLayout } from './components/layout/AppLayout';
import { workspaceApi, CloudUser } from './api/workspace';

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
  const [capabilitiesState, setCapabilitiesState] = useState<CapabilitiesState>({ static: null, runtime: null });
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);
  const { license } = useLicenseStatus();
  const upgradePromptState = useUpgradePromptState();
  const connectionState = useConnectionState();
  const versionCheckState = useVersionCheckState();

  useEffect(() => {
    metricsApi.getHealth()
      .then(health => {
        setCapabilitiesState({
          static: health.capabilities ?? null,
          runtime: health.runtimeCapabilities ?? null,
        });
      })
      .catch(console.error);

    workspaceApi.getMe()
      .then(setCloudUser)
      .catch(() => { /* Not in cloud mode */ });
  }, [connectionState.currentConnection?.id]);

  return (
    <BrowserRouter>
      <TooltipProvider>
        <ConnectionContext.Provider value={connectionState}>
          <UpgradePromptContext.Provider value={upgradePromptState}>
            <LicenseContext.Provider value={license}>
              <CapabilitiesContext.Provider value={capabilitiesState}>
                <VersionCheckContext.Provider value={versionCheckState}>
                  <AppLayout cloudUser={cloudUser} />
                  <Tooltip id="license-tooltip" />
                  <Tooltip id="info-tip" place="top" className="max-w-xs text-sm" style={{ zIndex: 50 }} />
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
      </TooltipProvider>
    </BrowserRouter>
  );
}

export default App;
