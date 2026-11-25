import { useEffect, useState } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import type { SettingsPanelProps } from '@openeverest/plugin-sdk';
import { api, SettingsView } from '../api';
import { PluginRoot } from './plugin-root';

// Read-only by design: the URL and token come from the Helm release (values
// or betterdb.existingSecret). The backend is reachable by any pod in the
// cluster, so it offers no way to repoint the agents.
export const SettingsPanel = (_props: SettingsPanelProps) => (
  <PluginRoot>
    <SettingsPanelBody />
  </PluginRoot>
);

const SettingsPanelBody = () => {
  const [current, setCurrent] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(setCurrent)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <Stack spacing={2} sx={{ p: 2, maxWidth: 640 }}>
      <Typography variant="h6">BetterDB</Typography>
      <Typography variant="body2" color="text.secondary">
        Where the in-cluster agent streams to.
      </Typography>
      {error && <Alert severity="warning">Could not reach the BetterDB plugin backend: {error}</Alert>}
      {current && (
        <>
          <Typography variant="body2">
            Agent URL: <code>{current.url || 'not set'}</code>
          </Typography>
          <Typography variant="body2">Agent token: {current.tokenSet ? 'stored' : 'not set'}</Typography>
          <Alert severity="info">
            These settings are managed by the Helm release. Change them with the chart values{' '}
            <code>betterdb.url</code> and <code>betterdb.token</code>, or point <code>betterdb.existingSecret</code> at a
            Secret with keys <code>url</code> and <code>token</code>; the plugin picks the change up without a restart.
            Create the token in BetterDB under Connections &rarr; Via Agent.
          </Alert>
        </>
      )}
    </Stack>
  );
};
