import { useEffect, useState } from 'react';
import { Alert, Button, Stack, TextField, Typography } from '@mui/material';
import type { SettingsPanelProps } from '@openeverest/plugin-sdk';
import { api, SettingsView } from '../api';
import { PluginRoot } from './plugin-root';

const URL_HELP =
  'BetterDB Cloud: wss://<workspace>.app.betterdb.com/agent/ws. Self-hosted: wss://<monitor-host>/api/agent/ws.';

export const SettingsPanel = (_props: SettingsPanelProps) => (
  <PluginRoot>
    <SettingsPanelBody />
  </PluginRoot>
);

const SettingsPanelBody = () => {
  const [current, setCurrent] = useState<SettingsView | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((settings) => {
        setCurrent(settings);
        setUrl(settings.url);
      })
      .catch((err: Error) => setMessage({ severity: 'error', text: err.message }));
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      // An empty token field keeps the stored one; the backend never returns it.
      const saved = await api.saveSettings({ url, ...(token ? { token } : {}) });
      setCurrent(saved);
      setToken('');
      setMessage({ severity: 'success', text: 'Saved. Enabled instances reconnect with the new settings.' });
    } catch (err) {
      setMessage({ severity: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={2} sx={{ p: 2, maxWidth: 640 }}>
      <Typography variant="h6">BetterDB</Typography>
      <Typography variant="body2" color="text.secondary">
        Where the in-cluster agent streams to. Create an agent token in BetterDB (Connections &rarr; Via Agent) and
        paste it here; it is stored in a Secret in the plugin&apos;s namespace.
      </Typography>
      <TextField
        label="BetterDB agent URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        helperText={URL_HELP}
        fullWidth
        size="small"
      />
      <TextField
        label="Agent token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        helperText={current?.tokenSet ? 'A token is stored. Leave empty to keep it.' : 'No token stored yet.'}
        fullWidth
        size="small"
        autoComplete="off"
      />
      {current?.source === 'env' && (
        <Alert severity="info">These values come from the chart&apos;s environment; saving here overrides them.</Alert>
      )}
      {message && <Alert severity={message.severity}>{message.text}</Alert>}
      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={saving || !url} onClick={() => void save()}>
          Save
        </Button>
      </Stack>
    </Stack>
  );
};
