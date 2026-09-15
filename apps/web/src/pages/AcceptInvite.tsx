import { ReactElement, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { InvitePreview, workspaceApi } from '../api/workspace';
import { useAuth } from '../contexts/AuthContext';
import { CredentialsForm } from '../components/auth/CredentialsForm';
import { InviteNotice } from '../components/accept-invite/InviteNotice';

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; preview: InvitePreview };

const INVALID_INVITE_STATUSES = new Set([400, 404]);

function isInvalidInvite(error: unknown): boolean {
  return error instanceof ApiError && INVALID_INVITE_STATUSES.has(error.status);
}

export function AcceptInvite(): ReactElement {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

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
      .catch((error: unknown) => {
        if (cancelled === true) {
          return;
        }
        setState({ kind: isInvalidInvite(error) ? 'invalid' : 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

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
  if (state.kind === 'unavailable') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-8">
        <div className="w-full max-w-sm space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            We couldn't load this invite. Check your connection and try again.
          </p>
          <button
            type="button"
            className="text-sm text-primary underline"
            onClick={() => {
              setAttempt((current) => {
                return current + 1;
              });
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
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
