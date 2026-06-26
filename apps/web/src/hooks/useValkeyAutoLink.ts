import { useEffect, useRef } from 'react';
import { fetchApi } from '../api/client';
import { databasesApi } from '../api/databases';
import { useConnection } from './useConnection';
import type { CloudUser } from '../api/workspace';

// While a cloud admin/owner is signed in, keep managed Valkey instances mirrored
// into the Monitor connection list: as soon as an instance is `ready`, register a
// direct TLS connection to it. This runs app-wide (not just inside the Add
// Connection dialog), so an instance still gets linked if the user provisions it
// and navigates away before provisioning finishes. The periodic reconcile also
// retries a link that failed transiently. Connections are tenant-scoped, so a
// member sees the connection once any admin/owner session has linked it; the
// credentials endpoint is admin/owner-only, which is why this is role-gated.
const POLL_INTERVAL_MS = 8000;

export function useValkeyAutoLink(cloudUser: CloudUser | null): void {
  const { connections, refreshConnections } = useConnection();
  // Instances we've already linked (or are linking), so we don't re-POST on
  // every tick before refreshConnections reflects the new connection.
  const linkedRef = useRef<Set<string>>(new Set());
  // Latest connections in a ref so the interval can read them without
  // re-subscribing on every connections change.
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;

  const isAdminOrOwner =
    cloudUser?.role === 'admin' || cloudUser?.role === 'owner';

  useEffect(() => {
    if (!isAdminOrOwner) return;

    let cancelled = false;

    const reconcile = async () => {
      let databases;
      try {
        databases = await databasesApi.list();
      } catch {
        return; // transient; retried on the next tick
      }
      if (cancelled) return;

      for (const db of databases) {
        if (db.status !== 'ready' || !db.host) continue;
        if (linkedRef.current.has(db.id)) continue;

        const alreadyConnected = connectionsRef.current.some(
          (c) => c.host === db.host && c.port === db.port,
        );
        if (alreadyConnected) {
          linkedRef.current.add(db.id);
          continue;
        }

        linkedRef.current.add(db.id);
        try {
          const creds = await databasesApi.credentials(db.id);
          await fetchApi('/connections', {
            method: 'POST',
            body: JSON.stringify({
              name: db.name,
              host: creds.host,
              port: creds.port,
              username: creds.username,
              password: creds.password,
              dbIndex: 0,
              tls: true,
              setAsDefault: connectionsRef.current.length === 0,
            }),
          });
          await refreshConnections();
        } catch (err) {
          // Allow a later tick to retry a transient failure.
          linkedRef.current.delete(db.id);
          console.error('Failed to auto-link Valkey instance:', err);
        }
      }
    };

    reconcile();
    const timer = setInterval(reconcile, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isAdminOrOwner, refreshConnections]);
}
