import { FormEvent, ReactElement, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface InviteFormProps {
  onInvite: (email: string, role: string) => Promise<void>;
}

export function InviteForm({ onInvite }: InviteFormProps): ReactElement {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      return;
    }
    setBusy(true);
    try {
      await onInvite(trimmed, role);
      setEmail('');
      setRole('member');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-4">Invite member</h2>
      <form onSubmit={handleSubmit} className="flex items-end gap-3">
        <div className="flex-1">
          <label
            htmlFor="invite-email"
            className="block text-sm font-medium text-muted-foreground mb-1"
          >
            Email
          </label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            placeholder="colleague@example.com"
            required
          />
        </div>
        <div>
          <label
            htmlFor="invite-role"
            className="block text-sm font-medium text-muted-foreground mb-1"
          >
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
            }}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <Button type="submit" disabled={busy || email.trim().length === 0}>
          {busy ? 'Inviting...' : 'Invite'}
        </Button>
      </form>
    </Card>
  );
}
