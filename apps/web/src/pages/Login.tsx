import { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { UnauthorizedError } from '../api/client';
import { workspaceApi } from '../api/workspace';
import { useAuth } from '../contexts/AuthContext';
import { CredentialsForm } from '../components/auth/CredentialsForm';

function resolveNext(next: string | null): string {
  if (next === null) {
    return '/';
  }
  if (next.startsWith('/') === false) {
    return '/';
  }
  if (next.startsWith('//') === true) {
    return '/';
  }
  return next;
}

export function Login(): ReactElement {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = useAuth();

  return (
    <CredentialsForm
      title="Sign in"
      submitLabel="Sign in"
      askName={false}
      onSubmit={async ({ email, password }) => {
        try {
          await workspaceApi.signIn({ email, password });
        } catch (err) {
          if (err instanceof UnauthorizedError) {
            throw new Error('Invalid email or password');
          }
          throw err;
        }
        await refresh();
        navigate(resolveNext(params.get('next')), { replace: true });
      }}
    />
  );
}
