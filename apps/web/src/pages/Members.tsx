import { ReactElement, useCallback, useEffect, useState } from 'react';
import { Invitation, Member, workspaceApi } from '../api/workspace';
import { useAuth } from '../contexts/AuthContext';
import { InvitationsTable } from '../components/members/InvitationsTable';
import { InviteForm } from '../components/members/InviteForm';
import { InviteLinkDialog } from '../components/members/InviteLinkDialog';
import { MembersTable } from '../components/members/MembersTable';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}

export function Members(): ReactElement {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const role: string = user?.role ?? 'member';
  const isOwner = user?.isOwner === true || role === 'owner';
  const isAdminOrOwner = isOwner === true || role === 'admin';
  const currentUserId = user?.userId ?? null;

  const loadData = useCallback(async (): Promise<void> => {
    try {
      const [membersData, invitationsData] = await Promise.all([
        workspaceApi.getMembers(),
        isAdminOrOwner ? workspaceApi.getInvitations() : Promise.resolve([]),
      ]);
      setMembers(membersData);
      setInvitations(invitationsData);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load the team'));
    } finally {
      setLoading(false);
    }
  }, [isAdminOrOwner]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const run = async (action: () => Promise<void>, fallback: string): Promise<void> => {
    setError(null);
    setSuccess(null);
    try {
      await action();
      await loadData();
    } catch (err) {
      setError(errorMessage(err, fallback));
    }
  };

  const handleInvite = async (email: string, inviteRole: string): Promise<void> => {
    await run(async () => {
      const created = await workspaceApi.invite({ email, role: inviteRole });
      if (created.url !== undefined) {
        setInviteLink(created.url);
        return;
      }
      setSuccess(`Invitation sent to ${email}`);
    }, 'Failed to create the invitation');
  };

  const handleRevoke = (invitation: Invitation): void => {
    run(async () => {
      await workspaceApi.revokeInvitation(invitation.id);
      setSuccess('Invitation revoked');
    }, 'Failed to revoke the invitation');
  };

  const handleChangeRole = (member: Member, nextRole: string): void => {
    run(async () => {
      await workspaceApi.updateMemberRole(member.id, nextRole);
      setSuccess(`${member.email} is now ${nextRole}`);
    }, 'Failed to change the role');
  };

  const handleTransfer = (member: Member): void => {
    if (
      window.confirm(`Make ${member.email} the workspace owner? You will become an admin.`) ===
      false
    ) {
      return;
    }
    run(async () => {
      await workspaceApi.transferOwnership(member.id);
      setSuccess(`${member.email} is now the owner`);
    }, 'Failed to transfer ownership');
  };

  const handleRemove = (member: Member): void => {
    if (window.confirm(`Remove ${member.email} from this workspace?`) === false) {
      return;
    }
    run(async () => {
      await workspaceApi.removeMember(member.id);
      setSuccess(`${member.email} has been removed`);
    }, 'Failed to remove the member');
  };

  if (loading === true) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Team</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Team</h1>
      {error !== null && (
        <div className="p-3 rounded-md bg-destructive/5 text-destructive border border-destructive/20 text-sm">
          {error}
        </div>
      )}
      {success !== null && (
        <div className="p-3 rounded-md bg-green-50 text-green-700 border border-green-200 text-sm">
          {success}
        </div>
      )}
      {isAdminOrOwner && <InviteForm onInvite={handleInvite} />}
      <MembersTable
        members={members}
        currentUserId={currentUserId}
        isOwner={isOwner}
        onChangeRole={handleChangeRole}
        onTransfer={handleTransfer}
        onRemove={handleRemove}
      />
      {isAdminOrOwner && invitations.length > 0 && (
        <InvitationsTable invitations={invitations} onRevoke={handleRevoke} />
      )}
      <InviteLinkDialog
        url={inviteLink}
        onClose={() => {
          setInviteLink(null);
        }}
      />
    </div>
  );
}
