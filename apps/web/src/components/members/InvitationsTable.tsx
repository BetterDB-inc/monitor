import { ReactElement } from 'react';
import type { Invitation } from '@/api/workspace';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface InvitationsTableProps {
  invitations: Invitation[];
  onRevoke: (invitation: Invitation) => void;
}

function statusVariant(status: string): 'warning' | 'success' | 'secondary' {
  if (status === 'pending') {
    return 'warning';
  }
  if (status === 'accepted') {
    return 'success';
  }
  return 'secondary';
}

export function InvitationsTable({ invitations, onRevoke }: InvitationsTableProps): ReactElement {
  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-4">Invitations</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Invited</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.map((invitation) => {
            return (
              <TableRow key={invitation.id}>
                <TableCell className="font-medium">{invitation.email}</TableCell>
                <TableCell>
                  <Badge variant="outline">{invitation.role}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(invitation.status)}>{invitation.status}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(invitation.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(invitation.expiresAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  {invitation.status === 'pending' && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        onRevoke(invitation);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
