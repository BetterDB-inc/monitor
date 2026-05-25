import { useState, useEffect, useCallback, useMemo } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { Tooltip } from 'react-tooltip';
import { TooltipProvider } from '@/components/ui/tooltip';
import { metricsApi } from './api/metrics';
import { fetchApi } from './api/client';
import { CapabilitiesContext, CapabilitiesState } from './hooks/useCapabilities';
import type { CapabilityRetryVerdict, RuntimeCapabilities } from './types/metrics';
import { LicenseContext, useLicenseStatus } from './hooks/useLicense';
import { UpgradePromptContext, useUpgradePromptState } from './hooks/useUpgradePrompt';
import { ConnectionContext, useConnectionState } from './hooks/useConnection';
import { VersionCheckContext, useVersionCheckState } from './hooks/useVersionCheck';
import { UpgradePrompt } from './components/UpgradePrompt';
import { ServerStartupGuard } from './components/ServerStartupGuard';
import { AppLayout } from './components/layout/AppLayout';
import { workspaceApi, CloudUser } from './api/workspace';
import { DemoProvider } from './contexts/DemoContext';

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
  const [capabilitiesData, setCapabilitiesData] = useState<Omit<CapabilitiesState, 'retryCapability'>>({
    static: null,
    runtime: null,
    reasons: {},
  });
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);
  const { license } = useLicenseStatus();
  const upgradePromptState = useUpgradePromptState();
  const connectionState = useConnectionState();
  const versionCheckState = useVersionCheckState();
  const currentConnectionId = connectionState.currentConnection?.id;

  const refreshCapabilities = useCallback(() => {
    metricsApi
      .getHealth()
      .then((health) => {
        setCapabilitiesData({
          static: health.capabilities ?? null,
          runtime: health.runtimeCapabilities ?? null,
          reasons: health.runtimeCapabilityReasons ?? {},
        });
      })
      .catch(console.error);
  }, []);

  const retryCapability = useCallback(
    async (capability: keyof RuntimeCapabilities): Promise<CapabilityRetryVerdict | undefined> => {
      if (!currentConnectionId) {
        return undefined;
      }
      const verdict = await fetchApi<CapabilityRetryVerdict>(
        `/connections/${encodeURIComponent(currentConnectionId)}/capabilities/${encodeURIComponent(capability)}/retry`,
        { method: 'POST' },
      );
      refreshCapabilities();
      return verdict;
    },
    [currentConnectionId, refreshCapabilities],
  );

  const capabilitiesState = useMemo<CapabilitiesState>(
    () => ({ ...capabilitiesData, retryCapability }),
    [capabilitiesData, retryCapability],
  );

  useEffect(() => {
    setCapabilitiesData({ static: null, runtime: null, reasons: {} });
    refreshCapabilities();

    workspaceApi.getMe()
      .then(setCloudUser)
      .catch(() => { /* Not in cloud mode */ });
  }, [currentConnectionId, refreshCapabilities]);

  return (
    <BrowserRouter>
      <DemoProvider>
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
      </DemoProvider>
    </BrowserRouter>
  );
}

export default App;
