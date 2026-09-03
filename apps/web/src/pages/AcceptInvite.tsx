import { ReactElement, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { InvitePreview, workspaceApi } from '../api/workspace';
import { useAuth } from '../contexts/AuthContext';
import { CredentialsForm } from '../components/auth/CredentialsForm';
import { InviteNotice } from '../components/accept-invite/InviteNotice';

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'ready'; preview: InvitePreview };

export function AcceptInvite(): ReactElement {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    workspaceApi
      .getInvite(token)
      .then((preview) => {
        if (cancelled === true) {
          return;
        }
        setState({ kind: 'ready', preview });
      })
      .catch(() => {
        if (cancelled === true) {
          return;
        }
        setState({ kind: 'invalid' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }
  if (state.kind === 'invalid') {
    return <InviteNotice>This invite link is not valid.</InviteNotice>;
  }
  if (state.preview.expired === true) {
    return (
      <InviteNotice>This invite has expired. Ask a workspace admin for a new link.</InviteNotice>
    );
  }
  return (
    <CredentialsForm
      title="Join the workspace"
      description={`You were invited as ${state.preview.role}. Set a name and password to finish.`}
      submitLabel="Create account"
      askName
      lockedEmail={state.preview.email}
      onSubmit={async ({ name, password }) => {
        await workspaceApi.acceptInvite(token, { name, password });
        await refresh();
        navigate('/', { replace: true });
      }}
    />
  );
}
