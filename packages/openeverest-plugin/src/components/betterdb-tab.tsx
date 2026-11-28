import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { ClusterDetailTabProps } from '@openeverest/plugin-sdk';
import { api, ApiError, InstanceView, TargetState } from '../api';
import { PluginRoot } from './plugin-root';

const POLL_MS = 5_000;

const STATE_LABEL: Record<TargetState, string> = {
  off: 'Off',
  connecting: 'Connecting',
  monitoring: 'Monitoring',
  error: 'Error',
};

const STATE_COLOR: Record<TargetState, 'default' | 'info' | 'success' | 'error'> = {
  off: 'default',
  connecting: 'info',
  monitoring: 'success',
  error: 'error',
};

export const BetterDbTab = ({ instanceName, namespace }: ClusterDetailTabProps) => (
  <PluginRoot>
    <BetterDbTabBody instanceName={instanceName} namespace={namespace} />
  </PluginRoot>
);

const BetterDbTabBody = ({ instanceName, namespace }: { instanceName: string; namespace: string }) => {
  const [view, setView] = useState<InstanceView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped by every Enable/Disable: a status poll that started before the
  // action must not overwrite the state the action returned.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const issued = generation.current;
    try {
      const status = await api.status(namespace, instanceName);
      if (issued !== generation.current) return;
      setView(status);
      setLoadError(null);
    } catch (err) {
      if (issued !== generation.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [namespace, instanceName]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = async () => {
    if (!view) return;
    setBusy(true);
    setActionError(null);
    generation.current += 1;
    try {
      setView(view.enabled ? await api.disable(namespace, instanceName) : await api.enable(namespace, instanceName));
    } catch (err) {
      setActionError(describeActionError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!view && !loadError) {
    return (
      <Box sx={{ p: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  const state: TargetState = view?.status.state ?? 'off';
  const dashboardUrl = view?.dashboardUrl ?? null;

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        <Typography variant="h6">BetterDB</Typography>
        <Chip size="small" label={STATE_LABEL[state]} color={STATE_COLOR[state]} />
        <Box sx={{ flexGrow: 1 }} />
        <Button variant={view?.enabled ? 'outlined' : 'contained'} disabled={busy || !view} onClick={() => void toggle()}>
          {view?.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button
          variant="text"
          component={Link}
          href={dashboardUrl ?? undefined}
          target="_blank"
          rel="noopener"
          disabled={!dashboardUrl || !view?.enabled}
        >
          Open in BetterDB
        </Button>
      </Stack>

      <Typography variant="body2" color="text.secondary">
        Streams this instance&apos;s metrics, slow commands, clients and keyspace analytics to BetterDB with the
        instance&apos;s connection credentials, read-only. Enabling needs the <code>read-connection</code> permission
        on this instance. No pods are restarted.
      </Typography>

      {loadError && <Alert severity="warning">Could not reach the BetterDB plugin backend: {loadError}</Alert>}
      {actionError && <Alert severity="error" onClose={() => setActionError(null)}>{actionError}</Alert>}
      {view?.status.error && state !== 'off' && (
        <Alert severity={state === 'error' ? 'error' : 'info'}>{view.status.error}</Alert>
      )}
      {!dashboardUrl && view?.enabled && (
        <Alert severity="info">
          BetterDB is not configured yet: set <code>betterdb.url</code> and <code>betterdb.token</code> (or{' '}
          <code>betterdb.existingSecret</code>) on the Helm release.
        </Alert>
      )}

      {view && view.status.nodes.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Node</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Address</TableCell>
              <TableCell>Valkey</TableCell>
              <TableCell>BetterDB</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {view.status.nodes.map((node) => (
              <TableRow key={node.id}>
                <TableCell>{node.name}</TableCell>
                <TableCell>{node.role}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>{node.address}</TableCell>
                <TableCell>{node.valkeyConnected ? 'connected' : 'disconnected'}</TableCell>
                <TableCell>
                  {node.cloudConnected ? 'streaming' : 'not connected'}
                  {node.error && (
                    <Typography variant="caption" color="error" display="block">
                      {node.error}
                    </Typography>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
};

function describeActionError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return `Not allowed: ${err.message}`;
    if (err.status === 401) return 'Your OpenEverest session was not accepted. Sign in again and retry.';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
