import { useState } from 'react';
import { useConnection } from '../hooks/useConnection';
import { fetchApi } from '../api/client';

interface ConnectionFormData {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  dbIndex: number;
  tls: boolean;
}

const defaultFormData: ConnectionFormData = {
  name: '',
  host: 'localhost',
  port: 6379,
  username: '',
  password: '',
  dbIndex: 0,
  tls: false,
};

export function ConnectionSelector() {
  const { currentConnection, connections, loading, error, setConnection, refreshConnections } = useConnection();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showManageDialog, setShowManageDialog] = useState(false);
  const [formData, setFormData] = useState<ConnectionFormData>(defaultFormData);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const handleInputChange = (field: keyof ConnectionFormData, value: string | number | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await fetchApi<{ success: boolean; message?: string; error?: string }>('/connections/test', {
        method: 'POST',
        body: JSON.stringify({
          name: formData.name || 'Test',
          host: formData.host,
          port: formData.port,
          username: formData.username || undefined,
          password: formData.password || undefined,
          dbIndex: formData.dbIndex,
          tls: formData.tls,
        }),
      });
      setTestResult({
        success: result.success,
        message: result.success ? 'Connection successful!' : (result.error || 'Connection failed'),
      });
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : 'Connection test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveConnection = async () => {
    if (!formData.name || !formData.host) {
      setTestResult({ success: false, message: 'Name and host are required' });
      return;
    }

    setSaving(true);
    try {
      await fetchApi<{ id: string }>('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: formData.name,
          host: formData.host,
          port: formData.port,
          username: formData.username || undefined,
          password: formData.password || undefined,
          dbIndex: formData.dbIndex,
          tls: formData.tls,
          setAsDefault: connections.length === 0,
        }),
      });
      setShowAddDialog(false);
      setFormData(defaultFormData);
      setTestResult(null);
      await refreshConnections();
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to save connection',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteConnection = async (id: string) => {
    if (!confirm('Are you sure you want to delete this connection?')) return;

    try {
      await fetchApi(`/connections/${id}`, { method: 'DELETE' });
      await refreshConnections();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete connection');
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await fetchApi(`/connections/${id}/default`, { method: 'POST' });
      await refreshConnections();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to set default');
    }
  };

  if (loading) {
    return (
      <div className="px-3 py-2 text-sm text-muted-foreground">
        Loading connections...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2">
        <div className="text-sm text-red-500 mb-2">{error}</div>
        <button
          onClick={() => setShowAddDialog(true)}
          className="text-xs text-primary hover:underline"
        >
          + Add Connection
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="px-3 py-2">
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-muted-foreground">Connection</label>
          <div className="flex gap-1">
            <button
              onClick={() => setShowAddDialog(true)}
              className="text-xs text-primary hover:underline"
              title="Add connection"
            >
              +
            </button>
            {connections.length > 0 && (
              <button
                onClick={() => setShowManageDialog(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
                title="Manage connections"
              >
                ⚙
              </button>
            )}
          </div>
        </div>

        {connections.length === 0 ? (
          <button
            onClick={() => setShowAddDialog(true)}
            className="w-full px-2 py-1.5 text-sm border border-dashed rounded-md hover:border-primary hover:text-primary transition-colors"
          >
            + Add your first connection
          </button>
        ) : connections.length === 1 ? (
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${connections[0].isConnected ? 'bg-green-500' : 'bg-red-500'}`}
            />
            <div className="min-w-0">
              <span className="text-sm font-medium truncate block">{connections[0].name}</span>
              <span className="text-xs text-muted-foreground">{connections[0].host}:{connections[0].port}</span>
            </div>
          </div>
        ) : (
          <select
            value={currentConnection?.id ?? ''}
            onChange={(e) => setConnection(e.target.value)}
            className="w-full px-2 py-1.5 text-sm bg-background border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {connections.map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.isConnected ? '● ' : '○ '}{conn.name} ({conn.host}:{conn.port})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Add Connection Dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg shadow-lg w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h2 className="text-lg font-semibold">Add Connection</h2>
              <button
                onClick={() => {
                  setShowAddDialog(false);
                  setFormData(defaultFormData);
                  setTestResult(null);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => handleInputChange('name', e.target.value)}
                  placeholder="Production Redis"
                  className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1">Host *</label>
                  <input
                    type="text"
                    value={formData.host}
                    onChange={(e) => handleInputChange('host', e.target.value)}
                    placeholder="localhost"
                    className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Port</label>
                  <input
                    type="number"
                    value={formData.port}
                    onChange={(e) => handleInputChange('port', parseInt(e.target.value) || 6379)}
                    className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Username</label>
                  <input
                    type="text"
                    value={formData.username}
                    onChange={(e) => handleInputChange('username', e.target.value)}
                    placeholder="default"
                    className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Password</label>
                  <input
                    type="password"
                    value={formData.password}
                    onChange={(e) => handleInputChange('password', e.target.value)}
                    className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Database Index</label>
                  <input
                    type="number"
                    value={formData.dbIndex}
                    onChange={(e) => handleInputChange('dbIndex', parseInt(e.target.value) || 0)}
                    min="0"
                    max="15"
                    className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.tls}
                      onChange={(e) => handleInputChange('tls', e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-sm">Use TLS</span>
                  </label>
                </div>
              </div>

              {testResult && (
                <div className={`p-3 rounded-md text-sm ${testResult.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                  {testResult.message}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/30">
              <button
                onClick={handleTestConnection}
                disabled={testing || !formData.host}
                className="px-4 py-2 text-sm border rounded-md hover:bg-muted disabled:opacity-50"
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowAddDialog(false);
                    setFormData(defaultFormData);
                    setTestResult(null);
                  }}
                  className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveConnection}
                  disabled={saving || !formData.name || !formData.host}
                  className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manage Connections Dialog */}
      {showManageDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg shadow-lg w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h2 className="text-lg font-semibold">Manage Connections</h2>
              <button
                onClick={() => setShowManageDialog(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            <div className="p-4 space-y-2 max-h-96 overflow-y-auto">
              {connections.map((conn) => (
                <div
                  key={conn.id}
                  className={`flex items-center justify-between p-3 border rounded-md ${
                    currentConnection?.id === conn.id ? 'border-primary bg-primary/5' : ''
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${conn.isConnected ? 'bg-green-500' : 'bg-red-500'}`}
                    />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{conn.name}</div>
                      <div className="text-xs text-muted-foreground">{conn.host}:{conn.port}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {currentConnection?.id !== conn.id && (
                      <button
                        onClick={() => {
                          setConnection(conn.id);
                          setShowManageDialog(false);
                        }}
                        className="text-xs px-2 py-1 border rounded hover:bg-muted"
                      >
                        Select
                      </button>
                    )}
                    <button
                      onClick={() => handleSetDefault(conn.id)}
                      className="text-xs px-2 py-1 border rounded hover:bg-muted"
                      title="Set as default"
                    >
                      ★
                    </button>
                    <button
                      onClick={() => handleDeleteConnection(conn.id)}
                      className="text-xs px-2 py-1 border border-red-500/50 text-red-500 rounded hover:bg-red-500/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/30">
              <button
                onClick={() => {
                  setShowManageDialog(false);
                  setShowAddDialog(true);
                }}
                className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
              >
                + Add Connection
              </button>
              <button
                onClick={() => setShowManageDialog(false)}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
