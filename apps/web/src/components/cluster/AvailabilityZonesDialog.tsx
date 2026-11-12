import { useState } from 'react';
import type { NodeAvailabilityZones } from '@betterdb/shared';
import { fetchApi } from '../../api/client';
import type { ClusterNode } from '../../types/metrics';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { formatZoneLines, parseZoneLines } from './availabilityZonesText';

interface AvailabilityZonesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  nodes: ClusterNode[];
  zones: NodeAvailabilityZones | undefined;
  onSaved: () => Promise<void> | void;
}

export function AvailabilityZonesDialog({
  open,
  onOpenChange,
  connectionId,
  nodes,
  zones,
  onSaved,
}: AvailabilityZonesDialogProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setText(formatZoneLines(nodes, zones));
      setError(null);
    }
  }

  const save = async () => {
    const parsed = parseZoneLines(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await fetchApi(`/connections/${connectionId}/availability-zones`, {
        method: 'PATCH',
        body: JSON.stringify({ zones: parsed.zones }),
      });
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save availability zones');
    } finally {
      setSaving(false);
    }
  };

  const dismiss = (next: boolean) => {
    if (!saving) {
      onOpenChange(next);
    }
  };

  return (
    <Dialog open={open} onOpenChange={dismiss}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Availability zones</DialogTitle>
          <DialogDescription>
            Set the zone of each node, one <code>host:port=zone</code> per line. A zone the server
            reports itself (Valkey 9.1+) always wins, and lines with no zone are ignored.
          </DialogDescription>
        </DialogHeader>
        <div>
          <label htmlFor="node-availability-zones" className="block text-xs font-medium mb-1">
            Node zones
          </label>
          <textarea
            id="node-availability-zones"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={Math.min(Math.max(nodes.length + 1, 6), 16)}
            placeholder="10.0.0.1:7001=us-east-1a"
            spellCheck={false}
            className="w-full px-3 py-2 border rounded-md bg-background font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
