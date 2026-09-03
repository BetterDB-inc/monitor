import { ReactElement } from 'react';
import type { Member } from '@/api/workspace';
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

interface MembersTableProps {
  members: Member[];
  currentUserId: string | null;
  isOwner: boolean;
  onChangeRole: (member: Member, role: string) => void;
  onTransfer: (member: Member) => void;
  onRemove: (member: Member) => void;
}

function roleBadgeVariant(member: Member): 'default' | 'secondary' | 'outline' {
  if (member.isOwner === true || member.role === 'owner') {
    return 'default';
  }
  if (member.role === 'admin') {
    return 'secondary';
  }
  return 'outline';
}

function roleLabel(member: Member): string {
  if (member.isOwner === true) {
    return 'owner';
  }
  return member.role;
}

export function MembersTable({
  members,
  currentUserId,
  isOwner,
  onChangeRole,
  onTransfer,
  onRemove,
}: MembersTableProps): ReactElement {
  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-4">Members</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Joined</TableHead>
            {isOwner && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const manageable =
              isOwner === true &&
              member.id !== currentUserId &&
              member.isOwner === false &&
              member.role !== 'owner';
            const nextRole = member.role === 'admin' ? 'member' : 'admin';
            return (
              <TableRow key={member.id}>
                <TableCell className="font-medium">{member.email}</TableCell>
                <TableCell>{member.name ?? '-'}</TableCell>
                <TableCell>
                  <Badge variant={roleBadgeVariant(member)}>{roleLabel(member)}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(member.createdAt).toLocaleDateString()}
                </TableCell>
                {isOwner && (
                  <TableCell className="text-right space-x-2">
                    {manageable && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            onChangeRole(member, nextRole);
                          }}
                        >
                          {nextRole === 'admin' ? 'Make admin' : 'Make member'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            onTransfer(member);
                          }}
                        >
                          Make owner
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            onRemove(member);
                          }}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
