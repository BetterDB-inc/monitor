import { useState, useEffect, useRef } from 'react';
import {
  databasesApi,
  Database,
  DatabaseCredentials,
  DatabaseStatus,
} from '../api/databases';
import { CloudUser } from '../api/workspace';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

interface DatabasesProps {
  cloudUser: CloudUser;
}

const MAX_DATABASES = 1;
const ACTIVE_STATUSES: DatabaseStatus[] = ['pending', 'provisioning', 'deleting'];

function statusVariant(status: DatabaseStatus) {
  switch (status) {
    case 'ready':
      return 'success' as const;
    case 'error':
      return 'destructive' as const;
    case 'suspended':
      return 'secondary' as const;
    default:
      return 'warning' as const;
  }
}

export function Databases({ cloudUser }: DatabasesProps) {
  const [databases, setDatabases] = useState<Database[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [maxmemory, setMaxmemory] = useState('768mb');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, DatabaseCredentials>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isAdminOrOwner = cloudUser.role === 'admin' || cloudUser.role === 'owner';
  const atCapacity = databases.length >= MAX_DATABASES;

  const loadData = async () => {
    try {
      const data = await databasesApi.list();
      setDatabases(data);
    } catch (err) {
      console.error('Failed to load databases:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Poll while any instance is still settling.
  useEffect(() => {
    const settling = databases.some((db) => ACTIVE_STATUSES.includes(db.status));
    if (settling && !pollRef.current) {
      pollRef.current = setInterval(loadData, 4000);
    } else if (!settling && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [databases]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      setCreating(true);
      setError(null);
      setSuccess(null);
      await databasesApi.create({
        name: name.trim().toLowerCase(),
        maxmemory: maxmemory.trim() || undefined,
      });
      setSuccess(`Creating database '${name.trim().toLowerCase()}'`);
      setName('');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to create database');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (db: Database) => {
    if (!confirm(`Delete database '${db.name}'? This permanently destroys its data.`)) return;

    try {
      setError(null);
      await databasesApi.remove(db.id);
      setSuccess(`Deleting database '${db.name}'`);
      setCredentials((prev) => {
        const next = { ...prev };
        delete next[db.id];
        return next;
      });
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to delete database');
    }
  };

  const handleShowCredentials = async (db: Database) => {
    if (credentials[db.id]) {
      setCredentials((prev) => {
        const next = { ...prev };
        delete next[db.id];
        return next;
      });
      return;
    }
    try {
      setError(null);
      const creds = await databasesApi.credentials(db.id);
      setCredentials((prev) => ({ ...prev, [db.id]: creds }));
    } catch (err: any) {
      setError(err.message || 'Failed to load credentials');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Databases</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Databases</h1>
      <p className="text-muted-foreground">
        Managed Valkey instances with the Search module, reachable over TLS.
      </p>

      {error && (
        <div className="p-3 rounded-md bg-destructive/5 text-destructive border border-destructive/20 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 rounded-md bg-green-50 text-green-700 border border-green-200 text-sm">
          {success}
        </div>
      )}

      {isAdminOrOwner && !atCapacity && (
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Create Database</h2>
          <form onSubmit={handleCreate} className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-cache"
                required
                pattern="[a-z][a-z0-9-]*[a-z0-9]"
                title="Lowercase letters, digits and hyphens; must start with a letter"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                Max memory
              </label>
              <select
                value={maxmemory}
                onChange={(e) => setMaxmemory(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="256mb">256mb</option>
                <option value="768mb">768mb</option>
                <option value="2gb">2gb</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:bg-muted disabled:cursor-not-allowed text-sm"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </form>
          <p className="text-xs text-muted-foreground mt-3">
            The name becomes the public hostname, so it must be unique. One database per
            workspace for now.
          </p>
        </Card>
      )}

      {databases.length === 0 ? (
        <Card className="p-6">
          <p className="text-muted-foreground text-sm">
            No databases yet. Create one above to get started.
          </p>
        </Card>
      ) : (
        databases.map((db) => {
          const creds = credentials[db.id];
          return (
            <Card key={db.id} className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold">{db.name}</h2>
                  <Badge variant={statusVariant(db.status)}>{db.status}</Badge>
                </div>
                {isAdminOrOwner && db.status !== 'deleting' && (
                  <button
                    onClick={() => handleDelete(db)}
                    className="text-sm text-destructive hover:text-destructive/80"
                  >
                    Delete
                  </button>
                )}
              </div>

              {db.statusMessage && db.status === 'error' && (
                <p className="text-sm text-destructive">{db.statusMessage}</p>
              )}

              {db.status === 'ready' && db.host ? (
                <div className="space-y-3">
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Host</dt>
                    <dd className="font-mono">{db.host}</dd>
                    <dt className="text-muted-foreground">Port</dt>
                    <dd className="font-mono">{db.port}</dd>
                    <dt className="text-muted-foreground">Username</dt>
                    <dd className="font-mono">{db.username}</dd>
                    <dt className="text-muted-foreground">TLS</dt>
                    <dd className="font-mono">required</dd>
                  </dl>

                  {isAdminOrOwner && (
                    <button
                      onClick={() => handleShowCredentials(db)}
                      className="text-sm text-primary hover:text-primary/80"
                    >
                      {creds ? 'Hide credentials' : 'Show credentials'}
                    </button>
                  )}

                  {creds && (
                    <div className="space-y-2 rounded-md border border-input bg-muted/40 p-3">
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Connection URL</div>
                        <code className="block break-all font-mono text-xs">
                          rediss://{creds.username}:{creds.password}@{creds.host}:{creds.port}
                        </code>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">valkey-cli</div>
                        <code className="block break-all font-mono text-xs">
                          valkey-cli --tls -h {creds.host} -p {creds.port} --user{' '}
                          {creds.username} --pass {creds.password}
                        </code>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {db.status === 'deleting'
                    ? 'Tearing down...'
                    : db.status === 'error'
                      ? 'Provisioning failed.'
                      : 'Provisioning, this can take a couple of minutes...'}
                </p>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
