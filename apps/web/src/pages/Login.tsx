import { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workspaceApi } from '../api/workspace';
import { useAuth } from '../contexts/AuthContext';
import { CredentialsForm } from '../components/auth/CredentialsForm';

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
        await workspaceApi.signIn({ email, password });
        await refresh();
        navigate(params.get('next') ?? '/', { replace: true });
      }}
    />
  );
}
